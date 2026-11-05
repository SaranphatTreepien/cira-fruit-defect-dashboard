"""
telegram_bot.py  --  Telegram menu bot for CIRA CORE Fruit Defect (read-only + acknowledge alerts).

Menu (keyboard buttons + Telegram command menu):
  สถานะ          camera / MQTT / DB / Internet / watcher / throughput      (DB queries, no AI)
  วันนี้          today's production, defect rate, confidence, run time      (no AI)
  Alert          open alerts, with "acknowledge" buttons                    (no AI)
  ประวัติเครื่อง   last camera on/off changes with durations                 (no AI)
  AI สรุปวันนี้ / AI สรุปสัปดาห์   Gemini writes a short summary from DB numbers
  any text       question to Gemini, which calls read-only tools to answer

Only TELEGRAM_CHAT_ID is served; other chats are ignored and logged. Gemini only receives aggregated
numbers and alert texts (no images, no secrets). One instance at a time (PostgreSQL advisory lock),
because Telegram allows a single getUpdates consumer per bot.

Run:   python scripts/telegram_bot.py            (also started by `npm run dev`)
Test:  python scripts/telegram_bot.py --selftest (prints menu answers + one AI summary, sends nothing)
Config (.env.local, then .env): DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
       Gemeni_api_key (or GEMINI_API_KEY), GEMINI_MODEL (default gemini-flash-lite-latest),
       MQTT_HOST, MQTT_PORT, HEALTHCHECK_URL, LOG_DIR
"""

import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler

import psycopg2
from psycopg2.extras import Json

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, ".."))


def load_env(path):
    try:
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


load_env(os.path.join(ROOT, ".env.local"))
load_env(os.path.join(ROOT, ".env"))

DSN = os.environ["DATABASE_URL"]
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
GEMINI_KEY = (os.environ.get("GEMINI_API_KEY") or os.environ.get("Gemeni_api_key") or "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest").strip()
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
HEALTHCHECK_URL = os.environ.get("HEALTHCHECK_URL", "https://www.google.com/generate_204")
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(ROOT, "logs"))
SINGLE_INSTANCE_LOCK = 727002
BKK = timezone(timedelta(hours=7))
RUNNING = {"playing", "started"}

os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("telegram_bot")
log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
_fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S")
_fh = RotatingFileHandler(os.path.join(LOG_DIR, "telegram_bot.log"), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
_fh.setFormatter(_fmt)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(_fmt)
log.addHandler(_fh)
log.addHandler(_sh)


# ================================================================ DB + read-only tools
class Db:
    def __init__(self):
        self.conn = None

    def cur(self):
        if self.conn is None or self.conn.closed:
            self.conn = psycopg2.connect(DSN, connect_timeout=3)
            self.conn.autocommit = True
        return self.conn.cursor()

    def rows(self, sql, params=()):
        try:
            with self.cur() as cur:
                cur.execute(sql, params)
                cols = [c.name for c in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]
        except psycopg2.Error:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None
            raise

    def one(self, sql, params=()):
        r = self.rows(sql, params)
        return r[0] if r else {}


db = Db()

PERIODS = {
    "1h": ("now() - interval '1 hour'", "now()", "1 ชั่วโมงล่าสุด"),
    "today": ("date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'", "now()", "วันนี้"),
    "yesterday": ("(date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - interval '1 day') AT TIME ZONE 'Asia/Bangkok'",
                  "date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'", "เมื่อวาน"),
    "24h": ("now() - interval '24 hours'", "now()", "24 ชั่วโมงล่าสุด"),
    "7d": ("now() - interval '7 days'", "now()", "7 วันล่าสุด"),
    "30d": ("now() - interval '30 days'", "now()", "30 วันล่าสุด"),
}


def num(v, digits=1):
    return None if v is None else round(float(v), digits)


def bkk(ts):
    return ts.astimezone(BKK).strftime("%d/%m %H:%M:%S") if ts else None


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def internet_ok():
    try:
        with urllib.request.urlopen(urllib.request.Request(HEALTHCHECK_URL, method="HEAD"), timeout=3) as r:
            return 200 <= r.status < 400
    except Exception:
        return False


def tool_status():
    """Machine + pipeline status right now."""
    devices = db.rows("SELECT device_id, source_type, state, age_sec, last_seen FROM device_status_live ORDER BY device_id")
    ev = db.one("""SELECT max(ts) AS last_ts, count(*) FILTER (WHERE ts >= now() - interval '60 seconds')::int AS last_min,
                          extract(epoch FROM now() - max(ts)) AS silent_sec FROM fruit_events""")
    lat = db.one("""SELECT avg(d) AS avg_s, max(d) AS max_s FROM (SELECT extract(epoch FROM created_at - ts) AS d
                    FROM fruit_events ORDER BY created_at DESC LIMIT 50) t""")
    w = db.one("SELECT extract(epoch FROM now() - updated_at) AS age FROM settings WHERE key = 'alert_watcher'")
    al = db.one("""SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                          count(*) FILTER (WHERE status = 'new' AND level <> 'info')::int AS unacked FROM alerts""")
    model = db.one("SELECT model_version FROM fruit_events ORDER BY ts DESC LIMIT 1")
    return {
        "devices": [{"device_id": d["device_id"], "source": d["source_type"], "state": d["state"],
                     "heartbeat_age_sec": num(d["age_sec"], 0), "last_seen": bkk(d["last_seen"])} for d in devices],
        "db": "online",
        "mqtt": "online" if port_open(MQTT_HOST, MQTT_PORT) else "offline",
        "internet": "online" if internet_ok() else "offline",
        "alert_watcher": "running" if w.get("age") is not None and float(w["age"]) < 30 else "stopped",
        "events_last_minute": ev.get("last_min", 0),
        "last_event": bkk(ev.get("last_ts")),
        "seconds_since_last_event": num(ev.get("silent_sec"), 0),
        "ingest_latency_avg_sec": num(lat.get("avg_s")),
        "ingest_latency_max_sec": num(lat.get("max_s")),
        "model_version": model.get("model_version"),
        "open_alerts": al.get("open", 0),
        "unacknowledged_alerts": al.get("unacked", 0),
    }


def tool_production(period="today"):
    """Production numbers for a period: 1h, today, yesterday, 24h, 7d, 30d."""
    start, end, label = PERIODS.get(period, PERIODS["today"])
    where = f"ts >= {start} AND ts < {end}"
    s = db.one(f"""SELECT count(*)::int AS total, count(*) FILTER (WHERE external_result = 'good')::int AS good,
                          count(*) FILTER (WHERE external_result = 'defect')::int AS defect, avg(confidence) AS conf,
                          min(ts) AS first_ts, max(ts) AS last_ts FROM fruit_events WHERE {where}""")
    fruits = db.rows(f"""SELECT COALESCE(fruit_type, 'unknown') AS fruit, count(*)::int AS total,
                                count(*) FILTER (WHERE external_result = 'defect')::int AS defect
                         FROM fruit_events WHERE {where} GROUP BY 1 ORDER BY 2 DESC""")
    defects = db.rows(f"""SELECT COALESCE(defect_type, 'ไม่ระบุ') AS defect_type, count(*)::int AS n FROM fruit_events
                          WHERE {where} AND external_result = 'defect' GROUP BY 1 ORDER BY 2 DESC""")
    peak = db.one(f"""SELECT to_char(date_trunc('hour', ts AT TIME ZONE 'Asia/Bangkok'), 'DD/MM HH24:00') AS hour, count(*)::int AS n
                      FROM fruit_events WHERE {where} GROUP BY 1 ORDER BY 2 DESC LIMIT 1""")
    run = db.one(f"""WITH seg AS (SELECT to_state, ts AS s, COALESCE(lead(ts) OVER (PARTITION BY device_id ORDER BY ts), now()) AS e
                                  FROM device_state_log)
                     SELECT COALESCE(sum(extract(epoch FROM LEAST(e, {end}) - GREATEST(s, {start}))), 0) AS sec
                     FROM seg WHERE to_state IN ('playing', 'started') AND e > {start} AND s < {end}""")
    alerts = db.one(f"SELECT count(*) FILTER (WHERE level <> 'info')::int AS n FROM alerts WHERE {where}")
    conf = s.get("conf")
    total = s.get("total", 0)
    return {
        "period": label, "total": total, "good": s.get("good", 0), "defect": s.get("defect", 0),
        "defect_rate_pct": num(s["defect"] / total * 100) if total else None,
        "avg_confidence_pct": num(float(conf) * 100 if conf is not None and conf <= 1 else conf),
        "first_event": bkk(s.get("first_ts")), "last_event": bkk(s.get("last_ts")),
        "by_fruit": fruits, "defect_types": defects,
        "peak_hour": peak or None,
        "machine_run_minutes": round(float(run.get("sec") or 0) / 60),
        "alerts_warning_or_critical": alerts.get("n", 0),
    }


def tool_trend(hours=12):
    """Hourly good/defect counts for the last N hours (max 72)."""
    hours = max(1, min(72, int(hours or 12)))
    rows = db.rows("""SELECT to_char(date_trunc('hour', ts AT TIME ZONE 'Asia/Bangkok'), 'DD/MM HH24:00') AS hour,
                             count(*) FILTER (WHERE external_result = 'good')::int AS good,
                             count(*) FILTER (WHERE external_result = 'defect')::int AS defect
                      FROM fruit_events WHERE ts >= now() - (%s * interval '1 hour') GROUP BY 1 ORDER BY 1""", (hours,))
    return {"hours": hours, "hourly": rows}


def tool_daily(days=7):
    """Per-day totals and defect rate for the last N Bangkok days (max 31)."""
    days = max(1, min(31, int(days or 7)))
    rows = db.rows("""SELECT to_char(ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS day, count(*)::int AS total,
                             count(*) FILTER (WHERE external_result = 'defect')::int AS defect, avg(confidence) AS conf
                      FROM fruit_events WHERE ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok' - (%s - 1) * interval '1 day'
                      GROUP BY 1 ORDER BY 1""", (days,))
    for r in rows:
        c = r.pop("conf")
        r["defect_rate_pct"] = num(r["defect"] / r["total"] * 100) if r["total"] else None
        r["avg_confidence_pct"] = num(float(c) * 100 if c is not None and c <= 1 else c)
    return {"days": days, "daily": rows}


def tool_alerts(hours=24, only_open=False):
    """Alerts in the last N hours (max 168); only_open=true for unresolved ones."""
    hours = max(1, min(168, int(hours or 24)))
    rows = db.rows(f"""SELECT id, ts, level, rule, title, detail, status, resolved_at FROM alerts
                       WHERE ts >= now() - (%s * interval '1 hour') {"AND resolved_at IS NULL" if only_open else ""}
                       ORDER BY ts DESC LIMIT 30""", (hours,))
    return {"hours": hours, "alerts": [{"id": r["id"], "time": bkk(r["ts"]), "level": r["level"], "rule": r["rule"],
                                        "title": r["title"], "detail": r["detail"], "acknowledged": r["status"] == "ack",
                                        "resolved": r["resolved_at"] is not None} for r in rows]}


def tool_device_history(limit=10):
    """Last camera state changes (on/off) with how long each state lasted."""
    limit = max(1, min(50, int(limit or 10)))
    rows = db.rows("""SELECT device_id, ts, from_state, to_state,
                             extract(epoch FROM (lead(ts) OVER (PARTITION BY device_id ORDER BY ts) - ts)) AS dur
                      FROM device_state_log ORDER BY ts DESC LIMIT %s""", (limit,))
    return {"changes": [{"device_id": r["device_id"], "time": bkk(r["ts"]), "from": r["from_state"], "to": r["to_state"],
                         "lasted_sec": num(r["dur"], 0)} for r in rows]}


TOOLS = {
    "get_status": (tool_status, "สถานะปัจจุบัน: กล้อง, MQTT, DB, Internet, watcher, ผล/นาที, ความหน่วง, alert ที่เปิดอยู่", {}),
    "get_production": (tool_production, "ยอดคัดแยกตามช่วงเวลา: รวม/ดี/เสีย, defect rate, confidence, ชนิดผลไม้, ประเภทตำหนิ, ชั่วโมงสูงสุด, เวลาเครื่องทำงาน",
                       {"period": {"type": "string", "enum": list(PERIODS), "description": "ช่วงเวลา"}}),
    "get_trend": (tool_trend, "จำนวนดี/เสียรายชั่วโมงย้อนหลัง N ชั่วโมง", {"hours": {"type": "integer", "description": "1-72"}}),
    "get_daily": (tool_daily, "สรุปรายวันย้อนหลัง N วัน", {"days": {"type": "integer", "description": "1-31"}}),
    "get_alerts": (tool_alerts, "รายการ alert ย้อนหลัง N ชั่วโมง",
                   {"hours": {"type": "integer", "description": "1-168"}, "only_open": {"type": "boolean", "description": "เฉพาะที่ยังไม่หาย"}}),
    "get_device_history": (tool_device_history, "ประวัติเปิด/ปิดกล้องล่าสุด", {"limit": {"type": "integer", "description": "1-50"}}),
}


# ================================================================ menu answers (no AI)
def esc(t):
    return str(t if t is not None else "-").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


STATE_TH = {"playing": "🟢 กำลังทำงาน", "started": "🟢 เริ่มทำงาน", "offline": "⚫ หยุด"}
ON = {"online": "🟢", "offline": "🔴", "running": "🟢", "stopped": "🔴"}


def text_status():
    s = tool_status()
    lines = ["<b>📊 สถานะระบบ</b>"]
    for d in s["devices"] or [{"device_id": "-", "state": None, "heartbeat_age_sec": None}]:
        lines.append(f"กล้อง {esc(d['device_id'])}: {STATE_TH.get(d['state'], esc(d['state']))} · heartbeat {esc(d['heartbeat_age_sec'])} วิ")
    lines.append(f"MQTT {ON[s['mqtt']]} · DB {ON[s['db']]} · Internet {ON[s['internet']]} · Watcher {ON[s['alert_watcher']]}")
    lines.append(f"ผล/นาที: <b>{s['events_last_minute']}</b> · event ล่าสุด {esc(s['last_event'])}")
    lines.append(f"ความหน่วง CIRA→DB เฉลี่ย {esc(s['ingest_latency_avg_sec'])} วิ (max {esc(s['ingest_latency_max_sec'])})")
    lines.append(f"โมเดล: {esc(s['model_version'])}")
    lines.append(f"Alert เปิดอยู่ {s['open_alerts']} · ยังไม่รับทราบ {s['unacknowledged_alerts']}")
    return "\n".join(lines)


def text_production(period="today"):
    p = tool_production(period)
    lines = [f"<b>📅 ยอดคัดแยก {esc(p['period'])}</b>"]
    if not p["total"]:
        lines.append("ยังไม่มีผลไม้ผ่านในช่วงนี้")
    else:
        lines.append(f"รวม <b>{p['total']:,}</b> · ดี {p['good']:,} · เสีย {p['defect']:,}")
        lines.append(f"Defect rate <b>{p['defect_rate_pct']}%</b> · confidence เฉลี่ย {esc(p['avg_confidence_pct'])}%")
        if p["by_fruit"]:
            lines.append("ชนิด: " + ", ".join(f"{esc(f['fruit'])} {f['total']:,} (เสีย {f['defect']:,})" for f in p["by_fruit"]))
        if p["defect_types"]:
            lines.append("ตำหนิ: " + ", ".join(f"{esc(d['defect_type'])} {d['n']:,}" for d in p["defect_types"]))
        if p["peak_hour"]:
            lines.append(f"ชั่วโมงสูงสุด {esc(p['peak_hour']['hour'])} ({p['peak_hour']['n']:,} ผล)")
        lines.append(f"ช่วงข้อมูล {esc(p['first_event'])} – {esc(p['last_event'])}")
    lines.append(f"เครื่องทำงาน {p['machine_run_minutes']} นาที · alert {p['alerts_warning_or_critical']}")
    return "\n".join(lines)


def text_alerts():
    a = tool_alerts(72, only_open=True)["alerts"]
    recent = [x for x in tool_alerts(24)["alerts"] if x["level"] != "info"][:5]
    icon = {"critical": "🔴", "warning": "🟠", "info": "🟢"}
    lines = [f"<b>🚨 Alert ที่ยังเปิดอยู่ ({len(a)})</b>"]
    if not a:
        lines.append("ไม่มี ✅")
    for x in a[:10]:
        lines.append(f"{icon.get(x['level'], '⚪')} #{x['id']} {esc(x['title'])} · {esc(x['time'])}{' · รับทราบแล้ว' if x['acknowledged'] else ''}")
    if recent:
        lines.append("\n<b>24 ชม. ล่าสุด (เตือน/วิกฤต)</b>")
        for x in recent:
            lines.append(f"{icon.get(x['level'], '⚪')} {esc(x['title'])} · {esc(x['time'])}{' · หายแล้ว' if x['resolved'] else ''}")
    unacked = [x for x in a if not x["acknowledged"] and x["level"] != "info"]
    buttons = [[{"text": f"✅ รับทราบ #{x['id']}", "callback_data": f"ack:{x['id']}"}] for x in unacked[:5]]
    if len(unacked) > 1:
        buttons.append([{"text": "✅ รับทราบทั้งหมด", "callback_data": "ack_all"}])
    return "\n".join(lines), ({"inline_keyboard": buttons} if buttons else None)


def text_history():
    h = tool_device_history(10)["changes"]
    lines = ["<b>🕘 ประวัติเปิด/ปิดกล้อง</b>"]
    if not h:
        lines.append("ยังไม่มีประวัติ")
    for x in h:
        dur = "ปัจจุบัน" if x["lasted_sec"] is None else fmt_dur(x["lasted_sec"])
        lines.append(f"{esc(x['time'])} {esc(x['device_id'])} → {STATE_TH.get(x['to'], esc(x['to']))} ({dur})")
    return "\n".join(lines)


def fmt_dur(sec):
    sec = int(sec or 0)
    return f"{sec} วิ" if sec < 60 else f"{sec // 60} นาที" if sec < 3600 else f"{sec / 3600:.1f} ชม."


# ================================================================ Gemini
SYSTEM_PROMPT = """คุณคือผู้ช่วยของระบบคัดแยกผลไม้ CIRA CORE (กล้อง AI ตรวจผลไม้ดี/เสีย แล้วบันทึกลง PostgreSQL)
ตอบเป็นภาษาไทย สั้น กระชับ อ่านง่ายบนมือถือ ใช้ข้อความธรรมดา (ไม่ใช้ markdown ตาราง) ใส่ emoji ได้เล็กน้อย
ใช้ตัวเลขจากเครื่องมือ (tools) หรือข้อมูลที่ให้มาเท่านั้น ห้ามเดาตัวเลข ถ้าไม่มีข้อมูลให้บอกตรงๆ
คำศัพท์: defect = ผลไม้เสีย, good = ดี, heartbeat = สัญญาณกล้องทุก 2 วินาที, offline = กล้องหยุด
ความหน่วง CIRA→DB ปกติราว 1-5 วินาที, defect_type ที่เป็น 'ไม่ระบุ' แปลว่าโมเดลไม่ได้ส่งประเภทตำหนิมา
ถ้าถามเรื่องที่ไม่เกี่ยวกับระบบนี้ ให้ตอบสั้นๆ ว่าช่วยได้เฉพาะเรื่องระบบคัดแยกผลไม้"""


class AiError(Exception):
    pass


def gemini(contents, tools=True):
    if not GEMINI_KEY:
        raise AiError("ยังไม่ได้ตั้ง Gemeni_api_key / GEMINI_API_KEY")
    body = {"systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]}, "contents": contents,
            "generationConfig": {"temperature": 0.3, "maxOutputTokens": 1200}}
    if tools:
        body["tools"] = [{"functionDeclarations": [
            {"name": name, "description": desc, "parameters": {"type": "object", "properties": props}} if props else {"name": name, "description": desc}
            for name, (_, desc, props) in TOOLS.items()]}]
    request = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                                     data=json.dumps(body).encode(), headers={"x-goog-api-key": GEMINI_KEY, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read()).get("error", {}).get("message", "")[:160]
        except Exception:
            pass
        if error.code == 429:
            raise AiError("AI ใช้โควตาฟรีเต็มแล้ว ลองใหม่ในอีกสักครู่")
        raise AiError(f"Gemini HTTP {error.code} {detail}")
    except Exception as error:
        raise AiError(f"เรียก Gemini ไม่สำเร็จ ({type(error).__name__})")
    candidates = data.get("candidates") or []
    if not candidates:
        raise AiError("Gemini ไม่ตอบ (อาจถูกกรองเนื้อหา)")
    return candidates[0].get("content", {"role": "model", "parts": []})


def ask_ai(question):
    """Free question: let Gemini call read-only tools (max 4 rounds)."""
    contents = [{"role": "user", "parts": [{"text": question[:1500]}]}]
    for _ in range(4):
        content = gemini(contents)
        parts = content.get("parts", [])
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            text = "".join(p.get("text", "") for p in parts).strip()
            return text or "ไม่มีคำตอบ"
        contents.append(content)
        responses = []
        for call in calls:
            name, args = call.get("name"), call.get("args") or {}
            func = TOOLS.get(name, (None,))[0]
            try:
                result = func(**args) if func else {"error": "unknown tool"}
            except TypeError:
                result = func() if func else {"error": "unknown tool"}
            except Exception as error:
                result = {"error": str(error)[:200]}
            log.info("AI tool %s %s", name, args)
            responses.append({"functionResponse": {"name": name, "response": {"result": json.loads(json.dumps(result, default=str))}}})
        contents.append({"role": "user", "parts": responses})
    return "AI เรียกข้อมูลหลายรอบเกินไป ลองถามให้เจาะจงขึ้น"


def ai_summary(scope="today"):
    """One-shot summary from pre-fetched numbers (one Gemini call, cheaper than tool rounds)."""
    data = {"status": tool_status(), "production": tool_production("today" if scope == "today" else "7d"),
            "daily": tool_daily(7 if scope == "week" else 2), "alerts": tool_alerts(24 if scope == "today" else 168),
            "device_history": tool_device_history(10)}
    if scope == "today":
        data["hourly_today"] = tool_trend(12)
        data["yesterday"] = tool_production("yesterday")
    prompt = (f"สรุป{'วันนี้' if scope == 'today' else 'สัปดาห์นี้ (7 วัน)'}ของไลน์คัดแยก จากข้อมูล JSON นี้ แบ่งเป็น\n"
              "1) ภาพรวม (ยอด ดี/เสีย defect rate เทียบช่วงก่อนถ้ามี)\n2) สถานะเครื่องและเหตุการณ์สำคัญ (alert, เปิด/ปิด)\n"
              "3) สิ่งที่ผิดปกติหรือควรระวัง\n4) ข้อแนะนำสั้นๆ 1-3 ข้อ\nไม่เกิน 15 บรรทัด\n\n"
              + json.dumps(data, ensure_ascii=False, default=str))
    content = gemini([{"role": "user", "parts": [{"text": prompt}]}], tools=False)
    return "".join(p.get("text", "") for p in content.get("parts", [])).strip() or "ไม่มีคำตอบ"


# ================================================================ Telegram
def tg(method, payload=None, timeout=35):
    request = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/{method}", data=json.dumps(payload or {}).encode(),
                                     headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read())
        except Exception:
            return {"ok": False, "description": f"HTTP {error.code}"}


BTN = {
    "status": "📊 สถานะ", "today": "📅 วันนี้", "alerts": "🚨 Alert", "history": "🕘 ประวัติเครื่อง",
    "ai_today": "🤖 AI สรุปวันนี้", "ai_week": "🤖 AI สรุปสัปดาห์", "help": "❓ วิธีใช้",
}
KEYBOARD = {"keyboard": [[{"text": BTN["status"]}, {"text": BTN["today"]}], [{"text": BTN["alerts"]}, {"text": BTN["history"]}],
                         [{"text": BTN["ai_today"]}, {"text": BTN["ai_week"]}], [{"text": BTN["help"]}]],
            "resize_keyboard": True, "is_persistent": True, "input_field_placeholder": "กดเมนู หรือพิมพ์ถาม AI"}
COMMANDS = [
    {"command": "status", "description": "สถานะกล้อง / MQTT / DB / Internet"},
    {"command": "today", "description": "ยอดคัดแยกวันนี้"},
    {"command": "alerts", "description": "Alert ที่ยังเปิดอยู่ + รับทราบ"},
    {"command": "history", "description": "ประวัติเปิด/ปิดกล้อง"},
    {"command": "ai_today", "description": "AI สรุปวันนี้"},
    {"command": "ai_week", "description": "AI สรุป 7 วัน"},
    {"command": "ask", "description": "ถาม AI เช่น /ask ชั่วโมงไหนเสียเยอะสุด"},
    {"command": "menu", "description": "แสดงปุ่มเมนู"},
]
HELP = ("<b>CIRA CORE Bot</b>\nกดปุ่มด้านล่าง หรือพิมพ์คำถามได้เลย เช่น\n"
        "• วันนี้เสียกี่เปอร์เซ็นต์\n• ชั่วโมงไหนคัดได้เยอะที่สุด\n• เมื่อวานกล้องดับกี่ครั้ง\n\n"
        "ปุ่ม 📊📅🚨🕘 ดึงจาก DB ตรง (เร็ว) · ปุ่ม 🤖 และคำถามใช้ Gemini")


def send(text, markup=None, html=True):
    payload = {"chat_id": CHAT_ID, "text": text[:4000], "disable_web_page_preview": True, "reply_markup": markup or KEYBOARD}
    if html:
        payload["parse_mode"] = "HTML"
    r = tg("sendMessage", payload)
    if not r.get("ok") and html:  # fall back to plain text if HTML parsing failed
        payload.pop("parse_mode")
        r = tg("sendMessage", payload)
    if not r.get("ok"):
        log.warning("sendMessage failed: %s", r.get("description"))


def typing():
    tg("sendChatAction", {"chat_id": CHAT_ID, "action": "typing"}, timeout=10)


def handle_text(text):
    t = text.strip()
    cmd = t.split()[0].split("@")[0].lower() if t.startswith("/") else ""
    rest = t[len(t.split()[0]):].strip() if cmd else t
    try:
        if cmd in ("/start", "/menu", "/help") or t == BTN["help"]:
            send(HELP)
        elif cmd == "/status" or t == BTN["status"]:
            send(text_status())
        elif cmd == "/today" or t == BTN["today"]:
            send(text_production("today"))
        elif cmd == "/alerts" or t == BTN["alerts"]:
            body, markup = text_alerts()
            send(body, markup)
        elif cmd == "/history" or t == BTN["history"]:
            send(text_history())
        elif cmd in ("/ai_today", "/ai_week") or t in (BTN["ai_today"], BTN["ai_week"]):
            typing()
            scope = "week" if cmd == "/ai_week" or t == BTN["ai_week"] else "today"
            send(f"🤖 AI สรุป{'วันนี้' if scope == 'today' else '7 วัน'}\n\n" + ai_summary(scope), html=False)
        elif cmd and cmd != "/ask":
            send("ไม่รู้จักคำสั่งนี้ กด ❓ วิธีใช้")
        elif rest:
            typing()
            send("🤖 " + ask_ai(rest), html=False)
        else:
            send("พิมพ์คำถามต่อจาก /ask ได้เลย เช่น /ask วันนี้เสียกี่ผล")
    except AiError as error:
        send(f"⚠️ {error}\n(เมนู 📊📅🚨🕘 ยังใช้ได้)", html=False)
    except psycopg2.Error:
        send("⚠️ ต่อฐานข้อมูลไม่ได้ตอนนี้ ลองใหม่อีกครั้ง", html=False)


def handle_callback(cb):
    data = cb.get("data", "")
    note = ""
    try:
        if data == "ack_all":
            n = db.rows("UPDATE alerts SET status = 'ack', acked_at = now(), acked_by = 'telegram' WHERE status = 'new' AND level <> 'info' RETURNING id")
            note = f"รับทราบแล้ว {len(n)} รายการ"
        elif data.startswith("ack:") and data[4:].isdigit():
            n = db.rows("UPDATE alerts SET status = 'ack', acked_at = now(), acked_by = 'telegram' WHERE id = %s AND status = 'new' RETURNING id", (int(data[4:]),))
            note = f"รับทราบ #{data[4:]} แล้ว" if n else "รายการนี้รับทราบไปแล้ว"
    except psycopg2.Error:
        note = "ต่อฐานข้อมูลไม่ได้"
    tg("answerCallbackQuery", {"callback_query_id": cb["id"], "text": note}, timeout=10)
    log.info("callback %s -> %s", data, note)


_lock_conn = None


def lock_alive():
    try:
        with _lock_conn.cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception:
        return False


def acquire_lock():
    """Dedicated connection holding the single-instance advisory lock."""
    global _lock_conn
    told = False
    while True:
        try:
            conn = psycopg2.connect(DSN, connect_timeout=3)
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute("SELECT pg_try_advisory_lock(%s)", (SINGLE_INSTANCE_LOCK,))
                if cur.fetchone()[0]:
                    _lock_conn = conn
                    return
            conn.close()
            if not told:
                log.info("มี telegram_bot อีกตัวทำงานอยู่ · ตัวนี้รอสำรอง")
                told = True
        except psycopg2.Error as error:
            if not told:
                log.error("DB not reachable: %s", str(error).strip().splitlines()[0])
                told = True
        time.sleep(10)


def run():
    if not (TOKEN and CHAT_ID):
        sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
    acquire_lock()
    r = tg("setMyCommands", {"commands": COMMANDS})
    log.info("START telegram_bot model=%s ai=%s commands=%s", GEMINI_MODEL, "on" if GEMINI_KEY else "off", "ok" if r.get("ok") else r.get("description"))
    tg("setChatMenuButton", {"menu_button": {"type": "commands"}})
    # Continue after the last handled update (stored in settings) so restarts do not replay messages.
    try:
        offset = int((db.one("SELECT value FROM settings WHERE key = 'telegram_bot'").get("value") or {}).get("offset", 0))
    except Exception:
        offset = 0
    if not offset:
        latest = tg("getUpdates", {"offset": -1, "timeout": 0}).get("result") or []
        offset = latest[-1]["update_id"] + 1 if latest else 0
    while True:
        try:
            r = tg("getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": ["message", "callback_query"]}, timeout=35)
            if not r.get("ok"):
                log.warning("getUpdates: %s", r.get("description"))
                time.sleep(5)
                continue
            for update in r.get("result", []):
                offset = update["update_id"] + 1
                msg = update.get("message") or {}
                cb = update.get("callback_query")
                chat = str((msg.get("chat") or (cb or {}).get("message", {}).get("chat") or {}).get("id", ""))
                if chat != CHAT_ID:
                    log.warning("ignored update from chat %s", chat)
                    continue
                if cb:
                    handle_callback(cb)
                elif msg.get("text"):
                    log.info("message: %s", msg["text"][:80])
                    handle_text(msg["text"])
            try:
                with db.cur() as cur:
                    cur.execute("""INSERT INTO settings (key, value, updated_at) VALUES ('telegram_bot', %s, now())
                                   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
                                (Json({"offset": offset, "pid": os.getpid()}),))
            except psycopg2.Error:
                db.conn = None
            if not lock_alive():
                log.warning("lost single-instance lock (DB reconnect) · re-acquiring")
                acquire_lock()
        except KeyboardInterrupt:
            log.info("STOP")
            return
        except Exception as error:
            log.error("loop error: %s", error)
            time.sleep(5)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        print(text_status(), "\n")
        print(text_production("today"), "\n")
        print(text_alerts()[0], "\n")
        print(text_history(), "\n")
        if "--ai" in sys.argv:
            print("AI summary:\n", ai_summary("today"), "\n")
            print("AI ask:\n", ask_ai("ชั่วโมงไหนวันนี้คัดได้เยอะที่สุด และ defect rate เท่าไร"))
        sys.exit(0)
    run()
