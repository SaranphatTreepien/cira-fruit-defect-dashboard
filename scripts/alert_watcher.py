"""
alert_watcher.py  --  watch the whole pipeline and record every incident as an alert in PostgreSQL.

Sources it watches:
  * Camera        VIEW device_status_live (+ its own MQTT subscription to cira/fruit/status/#).
                  Every state change is written to device_state_log. Camera on / off creates alerts.
  * Internet      HTTP check of HEALTHCHECK_URL.
  * MQTT broker   its own MQTT connection (client id cira-alert-watcher-<pid>, does not touch the
                  writer's persistent session).
  * Database      connection errors; the outage is recorded as one alert when the DB is back.
  * Writer        scripts/mqtt_to_db.py / mqtt_status.py: MQTT messages arrive but DB is not updated.
  * Data rules    settings.alert_rules: defect rate, no events while running, ingest latency.
  * Itself        watcher start / stop.

Problems open ONE alert per condition (dedup_key) and are resolved when they clear; recoveries are
written as resolved 'info' alerts so the dashboard can pop them up too. While the DB is down,
alerts are kept in memory and written once it is reachable again.

Telegram: every new alert is written with notify_status='pending'; the sender in this script posts
it to TELEGRAM_CHAT_ID and marks it 'sent' (or 'skipped' / 'failed'). While the Internet is down,
messages wait and are sent when it comes back. settings.alert_rules.telegram controls it.

Run:   python scripts/alert_watcher.py
Test:  python scripts/alert_watcher.py --test-telegram   (sends one test message and exits)
Config (.env.local, then .env, or environment): DATABASE_URL (required), TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID, MQTT_HOST, MQTT_PORT, HEALTHCHECK_URL, ALERT_TICK_SEC,
        ALERT_RULE_EVERY_SEC, ALERT_NET_EVERY_SEC, LOG_DIR
"""

import json
import logging
import os
import sys
import threading
from collections import deque
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler

import paho.mqtt.client as mqtt
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
load_env(os.path.join(ROOT, ".env"))  # Telegram keys live here; never logged

DSN = os.environ["DATABASE_URL"]
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
EVENT_TOPIC = os.environ.get("MQTT_TOPIC", "cira/fruit/events")
STATUS_TOPIC = os.environ.get("MQTT_STATUS_TOPIC", "cira/fruit/status/")
HEALTHCHECK_URL = os.environ.get("HEALTHCHECK_URL", "https://www.google.com/generate_204")
TICK_SEC = float(os.environ.get("ALERT_TICK_SEC", "2"))
RULE_EVERY_SEC = float(os.environ.get("ALERT_RULE_EVERY_SEC", "15"))
NET_EVERY_SEC = float(os.environ.get("ALERT_NET_EVERY_SEC", "5"))
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(ROOT, "logs"))
RUNNING_STATES = {"playing", "started"}
HEARTBEAT_FRESH_SEC = 6     # same timeout as VIEW device_status_live
WRITER_GRACE_SEC = 15      # MQTT event not in DB after this long -> writer problem
WRITER_LAG_SEC = 12         # MQTT heartbeat fresh but DB row older than this -> writer problem

DEFAULT_RULES = {
    "defect_rate": {"enabled": True, "threshold_pct": 70, "window_min": 10, "min_events": 30},
    "no_events": {"enabled": True, "after_sec": 60},
    "latency": {"enabled": True, "avg_sec": 10},
    "device": {"enabled": True, "notify_online": True},
    "mqtt": {"enabled": True},
    "internet": {"enabled": True},
    "writer": {"enabled": True},
    "telegram": {"enabled": True, "min_level": "info"},
}
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
NOTIFY_EVERY_SEC = 4
NOTIFY_MAX_ATTEMPTS = 5
BACKLOG_SKIP_MIN = 10       # on start, pending alerts older than this are not sent (avoid a flood)
SINGLE_INSTANCE_LOCK = 727001  # pg advisory lock id for alert_watcher
LEVEL_RANK = {"info": 0, "warning": 1, "critical": 2}
# Rules whose recovery has no dedicated message: a resolved one gets a "back to normal" info alert.
RECOVERY_NOTE_RULES = {"defect_rate_high", "no_events", "latency_high", "writer_down"}

os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("alert_watcher")
log.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
_fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S")
_fh = RotatingFileHandler(os.path.join(LOG_DIR, "alert_watcher.log"), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
_fh.setFormatter(_fmt)
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Thai text in Windows console
except Exception:
    pass
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(_fmt)
log.addHandler(_fh)
log.addHandler(_sh)


def utcnow():
    return datetime.now(timezone.utc)


def fmt_duration(sec):
    sec = int(sec)
    if sec < 60:
        return f"{sec} วินาที"
    if sec < 3600:
        return f"{sec // 60} นาที {sec % 60} วินาที"
    return f"{sec // 3600} ชม. {(sec % 3600) // 60} นาที"


# ---------------------------------------------------------------- outbox
class Outbox:
    """Alert actions queued in memory; written in order when the DB is reachable."""

    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def open(self, rule, level, title, detail, key, device_id=None, data=None):
        self._add(("open", utcnow(), rule, level, title, detail, key, device_id, data))

    def resolve(self, key):
        self._add(("resolve", utcnow(), key))

    def info(self, rule, title, detail, key, device_id=None, data=None, level="info", ts=None):
        self._add(("info", ts or utcnow(), rule, level, title, detail, key, device_id, data))

    def _add(self, item):
        with self.lock:
            self.items.append(item)
            if len(self.items) > 5000:
                self.items = self.items[-5000:]

    def flush(self, cur):
        while True:
            with self.lock:
                if not self.items:
                    return
                item = self.items[0]
            kind, ts = item[0], item[1]
            if kind == "open":
                _, _, rule, level, title, detail, key, device_id, data = item
                cur.execute(
                    """INSERT INTO alerts (ts, rule, level, device_id, title, detail, data, dedup_key)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (dedup_key) WHERE resolved_at IS NULL
                       DO UPDATE SET detail = EXCLUDED.detail, data = EXCLUDED.data
                       RETURNING (xmax = 0)""",
                    (ts, rule, level, device_id, title, detail, Json(data or {}), key),
                )
                if cur.fetchone()[0]:
                    log.warning("ALERT %s %s | %s | %s", level.upper(), key, title, detail)
            elif kind == "resolve":
                cur.execute("UPDATE alerts SET resolved_at = %s WHERE dedup_key = %s AND resolved_at IS NULL RETURNING id, rule, title, device_id, ts",
                            (ts, item[2]))
                row = cur.fetchone()
                if row:
                    log.info("RESOLVED %s", item[2])
                    alert_id, rule, title, device_id, opened = row
                    if rule in RECOVERY_NOTE_RULES:
                        lasted = (ts - opened).total_seconds()
                        cur.execute(
                            """INSERT INTO alerts (ts, rule, level, device_id, title, detail, data, dedup_key, resolved_at)
                               VALUES (%s, %s, 'info', %s, %s, %s, %s, %s, now())""",
                            (ts, f"{rule}_ok", device_id, f"กลับสู่ปกติ: {title}", f"เกิดขึ้นนาน {fmt_duration(lasted)}",
                             Json({"alert_id": alert_id, "lasted_sec": round(lasted)}), f"{rule}_ok:{alert_id}"),
                        )
                        log.info("INFO %s_ok | กลับสู่ปกติ: %s", rule, title)
            else:
                _, _, rule, level, title, detail, key, device_id, data = item
                cur.execute(
                    """INSERT INTO alerts (ts, rule, level, device_id, title, detail, data, dedup_key, resolved_at)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now())""",
                    (ts, rule, level, device_id, title, detail, Json(data or {}), key),
                )
                log.info("%s %s | %s | %s", level.upper(), key, title, detail)
            with self.lock:
                self.items.pop(0)


# ---------------------------------------------------------------- MQTT monitor
class MqttMonitor:
    """Own MQTT connection: tells whether the broker is up and when CIRA last sent messages."""

    def __init__(self):
        self.connected = False
        self.last_status = {}   # device_id -> epoch of last heartbeat seen on MQTT
        self.last_event = 0.0   # epoch of last fruit event message seen on MQTT
        self.event_times = deque(maxlen=500)  # receive times of recent fruit event messages
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"cira-alert-watcher-{os.getpid()}", clean_session=True)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(1, 10)

    def start(self):
        self.client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=10)
        self.client.loop_start()

    def stop(self):
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = not reason_code.is_failure
        if self.connected:
            client.subscribe([(STATUS_TOPIC + "#", 0), (EVENT_TOPIC, 0)])

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        self.connected = False

    def on_message(self, client, userdata, msg):
        now = time.time()
        if msg.topic.startswith(STATUS_TOPIC):
            device = msg.topic[len(STATUS_TOPIC):] or "unknown"
            try:
                device = json.loads(msg.payload).get("device_id") or device
            except Exception:
                pass
            self.last_status[device] = now
        else:
            self.last_event = now
            self.event_times.append(now)


def internet_up():
    try:
        request = urllib.request.Request(HEALTHCHECK_URL, method="HEAD")
        with urllib.request.urlopen(request, timeout=3) as response:
            return 200 <= response.status < 400
    except Exception:
        return False


# ---------------------------------------------------------------- Telegram
LEVEL_ICON = {"critical": "🔴", "warning": "🟠", "info": "🟢"}
LEVEL_TH = {"critical": "วิกฤต", "warning": "เตือน", "info": "ข้อมูล"}


def html_escape(text):
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def telegram_send(text):
    """POST sendMessage. Returns (ok, retry_after_sec, error). The token is never logged."""
    body = json.dumps({"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}).encode()
    request = urllib.request.Request(f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage", data=body,
                                     headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read() or b"{}")
            return bool(payload.get("ok")), 0, "" if payload.get("ok") else str(payload.get("description", "not ok"))[:200]
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read() or b"{}")
        except Exception:
            payload = {}
        retry = int((payload.get("parameters") or {}).get("retry_after", 0))
        return False, retry, f"HTTP {error.code}: {str(payload.get('description', ''))[:180]}"
    except Exception as error:
        return False, 0, type(error).__name__ + ": " + str(error)[:160]


def format_alert(ts, level, title, detail, device_id, resolved_at, rule):
    local = ts.astimezone(timezone(timedelta(hours=7))).strftime("%d/%m %H:%M:%S")
    lines = [f"{LEVEL_ICON.get(level, '⚪')} <b>{html_escape(title)}</b>"]
    if detail:
        lines.append(html_escape(detail))
    meta = [f"ระดับ {LEVEL_TH.get(level, level)}", local]
    if device_id:
        meta.insert(0, html_escape(device_id))
    if level != "info" and resolved_at is not None:
        meta.append("✅ หายแล้วตอนส่ง")
    lines.append(" · ".join(meta))
    lines.append(f"<i>CIRA CORE · {html_escape(rule)}</i>")
    return "\n".join(lines)


class TelegramNotifier:
    def __init__(self):
        self.configured = bool(TELEGRAM_TOKEN and TELEGRAM_CHAT_ID)
        self.pause_until = 0.0
        self.last_run = 0.0
        self.backlog_done = False

    def process(self, cur, rules, internet_ok):
        conf = rules.get("telegram", {})
        if not self.configured or not conf.get("enabled", True):
            cur.execute("UPDATE alerts SET notify_status = 'skipped', notify_error = %s WHERE notify_status = 'pending'",
                        ("telegram disabled" if self.configured else "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set",))
            return
        if not self.backlog_done:
            cur.execute("""UPDATE alerts SET notify_status = 'skipped', notify_error = 'old backlog at watcher start'
                           WHERE notify_status = 'pending' AND ts < now() - (%s * interval '1 minute')""", (BACKLOG_SKIP_MIN,))
            if cur.rowcount:
                log.info("TELEGRAM skipped %s old pending alerts", cur.rowcount)
            self.backlog_done = True
        now = time.time()
        if internet_ok is False or now < self.pause_until or now - self.last_run < NOTIFY_EVERY_SEC:
            return
        self.last_run = now
        min_rank = LEVEL_RANK.get(conf.get("min_level", "info"), 0)
        cur.execute("""SELECT id, ts, level, title, detail, device_id, resolved_at, rule, notify_attempts
                       FROM alerts WHERE notify_status = 'pending' ORDER BY id LIMIT 10""")
        for alert_id, ts, level, title, detail, device_id, resolved_at, rule, attempts in cur.fetchall():
            if LEVEL_RANK.get(level, 0) < min_rank:
                cur.execute("UPDATE alerts SET notify_status = 'skipped', notify_error = 'below min_level' WHERE id = %s", (alert_id,))
                continue
            ok, retry_after, error = telegram_send(format_alert(ts, level, title, detail, device_id, resolved_at, rule))
            if ok:
                cur.execute("UPDATE alerts SET notify_status = 'sent', notified_at = now(), notify_attempts = notify_attempts + 1, notify_error = NULL WHERE id = %s", (alert_id,))
                log.info("TELEGRAM sent #%s %s", alert_id, title)
                time.sleep(1.1)  # stay under Telegram's per-chat rate limit
                continue
            status = "failed" if attempts + 1 >= NOTIFY_MAX_ATTEMPTS else "pending"
            cur.execute("UPDATE alerts SET notify_status = %s, notify_attempts = notify_attempts + 1, notify_error = %s WHERE id = %s",
                        (status, error, alert_id))
            log.warning("TELEGRAM failed #%s (attempt %s): %s", alert_id, attempts + 1, error)
            self.pause_until = time.time() + max(retry_after, 5 * (attempts + 1))
            break


def load_rules(cur):
    cur.execute("SELECT value FROM settings WHERE key = 'alert_rules'")
    row = cur.fetchone()
    rules = json.loads(json.dumps(DEFAULT_RULES))
    if row and isinstance(row[0], dict):
        for name, conf in row[0].items():
            if isinstance(conf, dict):
                rules.setdefault(name, {}).update(conf)
    return rules


# ---------------------------------------------------------------- watcher
class Watcher:
    def __init__(self):
        self.conn = None
        self.out = Outbox()
        self.mq = MqttMonitor()
        self.tg = TelegramNotifier()
        self.rules = json.loads(json.dumps(DEFAULT_RULES))
        self.states = {}            # device_id -> (state, since_epoch)
        self.net = {"internet": None, "mqtt": None}   # last known True/False
        self.net_since = {}
        self.db_down_since = None
        self.db_error = ""
        self.started_logged = False
        self.states_loaded = False
        self.last_rules = 0.0
        self.last_rule_check = 0.0
        self.last_net_check = 0.0

    # --- network (works without the DB; results go to the outbox)
    def check_network(self):
        checks = {"internet": internet_up(), "mqtt": self.mq.connected}
        meta = {
            "internet": ("internet_down", "warning", "Internet ใช้งานไม่ได้", f"เชื่อมต่อ {HEALTHCHECK_URL} ไม่ได้", "Internet กลับมาแล้ว"),
            "mqtt": ("mqtt_down", "critical", "MQTT broker เชื่อมต่อไม่ได้", f"{MQTT_HOST}:{MQTT_PORT}", "MQTT broker กลับมาแล้ว"),
        }
        for name, up in checks.items():
            prev = self.net[name]
            if prev == up:
                continue
            rule, level, title, detail, back_title = meta[name]
            enabled = self.rules.get(name, {}).get("enabled", True)
            now = time.time()
            if not up and enabled:
                self.out.open(rule, level, title, detail, rule)
            elif up and prev is False:
                self.out.resolve(rule)
                if enabled:
                    down_for = now - self.net_since.get(name, now)
                    self.out.info(f"{name}_up", back_title, f"ล่มไป {fmt_duration(down_for)}", f"{name}_up:{int(now)}", data={"down_sec": round(down_for)})
            elif up:
                self.out.resolve(rule)
            log.info("NET %s: %s -> %s", name, prev, "up" if up else "down")
            self.net[name] = up
            self.net_since[name] = now

    # --- camera
    def init_states(self, cur):
        cur.execute("""SELECT DISTINCT ON (device_id) device_id, to_state, extract(epoch FROM ts)
                       FROM device_state_log ORDER BY device_id, ts DESC""")
        self.states = {d: (s, float(t)) for d, s, t in cur.fetchall()}

    def check_devices(self, cur):
        cur.execute("SELECT device_id, state, age_sec, extract(epoch FROM last_seen) FROM device_status_live")
        now = time.time()
        for device_id, state, age_sec, last_seen in cur.fetchall():
            state = state or "unknown"
            mqtt_seen = self.mq.last_status.get(device_id, 0)
            # DB says offline but CIRA is still sending heartbeats -> writer problem, not a camera stop.
            if state == "offline" and now - mqtt_seen < HEARTBEAT_FRESH_SEC:
                continue
            prev = self.states.get(device_id, (None, now))[0]
            if state == prev:
                continue
            cur.execute("INSERT INTO device_state_log (device_id, from_state, to_state, age_sec) VALUES (%s, %s, %s, %s)",
                        (device_id, prev, state, age_sec))
            log.info("STATE %s: %s -> %s (age %ss)", device_id, prev, state, age_sec)
            prev_since = self.states.get(device_id, (None, now))[1]
            self.states[device_id] = (state, now)
            dev = self.rules["device"]
            if not dev.get("enabled", True):
                continue
            key = f"device_offline:{device_id}"
            if state == "offline" and prev in RUNNING_STATES:
                self.out.open("device_offline", "warning", f"กล้อง {device_id} หยุดทำงาน",
                              f"ไม่มี heartbeat {age_sec} วินาที · ทำงานมา {fmt_duration(now - prev_since)}", key, device_id,
                              {"from": prev, "age_sec": float(age_sec or 0), "ran_sec": round(now - prev_since)})
            elif state in RUNNING_STATES and prev not in RUNNING_STATES:
                self.out.resolve(key)
                if dev.get("notify_online", True):
                    off_for = f" · หยุดไป {fmt_duration(now - prev_since)}" if prev == "offline" else ""
                    self.out.info("device_online", f"กล้อง {device_id} เปิดทำงาน", f"state = {state}{off_for}",
                                  f"device_online:{device_id}:{int(now)}", device_id, {"to": state, "from": prev})

    # --- writer (mqtt_to_db.py / mqtt_status.py)
    def check_writer(self, cur):
        if not self.rules.get("writer", {}).get("enabled", True):
            self.out.resolve("writer_down")
            return
        now = time.time()
        problems = []
        cur.execute("SELECT device_id, extract(epoch FROM last_seen) FROM device_status")
        db_seen = {d: float(t) for d, t in cur.fetchall()}
        for device, mqtt_seen in self.mq.last_status.items():
            if now - mqtt_seen < HEARTBEAT_FRESH_SEC and now - db_seen.get(device, 0) > WRITER_LAG_SEC:
                problems.append(f"heartbeat ของ {device} มาทาง MQTT แต่ device_status ไม่อัปเดต")
        # An event received on MQTT more than WRITER_GRACE_SEC ago that is still newer than the last
        # DB insert means the writer is not writing (the batch flush normally takes ~1-3 s).
        waiting = [t for t in list(self.mq.event_times) if WRITER_GRACE_SEC < now - t < 120]
        if waiting:
            cur.execute("SELECT extract(epoch FROM max(created_at)) FROM fruit_events")
            last_insert = float(cur.fetchone()[0] or 0)
            stuck = [t for t in waiting if t > last_insert + 2]
            if stuck:
                problems.append(f"มี event ทาง MQTT {len(stuck)} รายการที่ยังไม่ถูกเขียนลง fruit_events เกิน {WRITER_GRACE_SEC} วินาที")
        if problems:
            self.out.open("writer_down", "critical", "ตัวบันทึกข้อมูลลง DB ไม่ทำงาน",
                          " · ".join(problems) + " · ตรวจ scripts/mqtt_to_db.py", "writer_down")
        else:
            self.out.resolve("writer_down")

    # --- data rules
    def check_rules(self, cur):
        r = self.rules
        dr = r["defect_rate"]
        if dr.get("enabled", True):
            cur.execute("""SELECT count(*), count(*) FILTER (WHERE external_result = 'defect')
                           FROM fruit_events WHERE ts >= now() - (%s * interval '1 minute')""", (int(dr.get("window_min", 10)),))
            total, defect = cur.fetchone()
            rate = (defect / total * 100) if total else 0.0
            if total >= int(dr.get("min_events", 30)) and rate > float(dr.get("threshold_pct", 70)):
                self.out.open("defect_rate_high", "warning", f"Defect rate สูง {rate:.1f}%",
                              f"{defect}/{total} ผลใน {dr.get('window_min')} นาที (เกณฑ์ {dr.get('threshold_pct')}%)",
                              "defect_rate_high", data={"rate": round(rate, 2), "total": total, "defect": defect})
            else:
                self.out.resolve("defect_rate_high")
        else:
            self.out.resolve("defect_rate_high")

        ne = r["no_events"]
        after = int(ne.get("after_sec", 60))
        cur.execute("SELECT extract(epoch FROM now() - max(ts)) FROM fruit_events")
        silent = cur.fetchone()[0]
        now = time.time()
        for device_id, (state, since) in self.states.items():
            key = f"no_events:{device_id}"
            if ne.get("enabled", True) and state in RUNNING_STATES and now - since > after and (silent is None or float(silent) > after):
                self.out.open("no_events", "warning", f"{device_id} ทำงานอยู่แต่ไม่มีผลไม้เข้า",
                              f"ไม่มี event มา {int(float(silent)) if silent is not None else '-'} วินาที (เกณฑ์ {after} วินาที)",
                              key, device_id, {"silent_sec": float(silent) if silent is not None else None})
            else:
                self.out.resolve(key)

        la = r["latency"]
        cur.execute("""SELECT avg(extract(epoch FROM created_at - ts)), count(*)
                       FROM fruit_events WHERE created_at >= now() - interval '2 minutes'""")
        avg, n = cur.fetchone()
        if la.get("enabled", True) and n >= 5 and avg is not None and float(avg) > float(la.get("avg_sec", 10)):
            self.out.open("latency_high", "warning", f"ความหน่วง CIRA ถึง DB สูง {float(avg):.1f} วินาที",
                          f"เฉลี่ยจาก {n} event ใน 2 นาที (เกณฑ์ {la.get('avg_sec')} วินาที)", "latency_high", data={"avg_sec": float(avg), "n": n})
        elif not la.get("enabled", True) or (n >= 5 and avg is not None):
            self.out.resolve("latency_high")

    # --- database outage bookkeeping
    def on_db_back(self):
        if self.db_down_since is None:
            return
        down_for = time.time() - self.db_down_since
        ts = datetime.fromtimestamp(self.db_down_since, timezone.utc)
        self.out.info("db_down", "ฐานข้อมูล (PostgreSQL) เชื่อมต่อไม่ได้", f"ล่มไป {fmt_duration(down_for)} · กลับมาแล้ว · {self.db_error[:160]}",
                      f"db_down:{int(self.db_down_since)}", level="critical", ts=ts, data={"down_sec": round(down_for)})
        log.info("DB back after %s", fmt_duration(down_for))
        self.db_down_since = None

    def wait_for_single_instance(self):
        """Hold a PostgreSQL advisory lock so only one watcher works at a time (manual run + npm run dev)."""
        told = False
        while True:
            try:
                conn = psycopg2.connect(DSN, connect_timeout=3)
                conn.autocommit = True
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_try_advisory_lock(%s)", (SINGLE_INSTANCE_LOCK,))
                    if cur.fetchone()[0]:
                        self.conn = conn
                        return
                conn.close()
                if not told:
                    log.info("มี alert_watcher อีกตัวทำงานอยู่แล้ว · ตัวนี้รอสำรอง (ตรวจทุก 10 วินาที)")
                    told = True
            except psycopg2.Error as error:
                if not told:
                    log.error("DB not reachable at start: %s (retrying)", str(error).strip().splitlines()[0] if str(error).strip() else error)
                    told = True
            time.sleep(10)

    def run(self):
        self.wait_for_single_instance()
        log.info("START alert_watcher tick=%ss rules=%ss net=%ss telegram=%s", TICK_SEC, RULE_EVERY_SEC, NET_EVERY_SEC,
                 "on" if self.tg.configured else "not configured")
        self.mq.start()
        backoff = 1
        try:
            while True:
                if time.time() - self.last_net_check >= NET_EVERY_SEC:
                    self.check_network()
                    self.last_net_check = time.time()
                try:
                    if self.conn is None or self.conn.closed or not self.states_loaded:
                        if self.conn is None or self.conn.closed:
                            self.conn = psycopg2.connect(DSN, connect_timeout=3)
                            self.conn.autocommit = True
                            with self.conn.cursor() as cur:
                                cur.execute("SELECT pg_try_advisory_lock(%s)", (SINGLE_INSTANCE_LOCK,))
                                if not cur.fetchone()[0]:
                                    log.warning("อีก watcher รับงานต่อระหว่าง DB หลุด · ตัวนี้หยุด")
                                    self.out.items.clear()
                                    self.lost_lock = True
                                    return
                        with self.conn.cursor() as cur:
                            self.init_states(cur)
                        self.states_loaded = True
                        log.info("DB connected")
                        self.on_db_back()
                        backoff = 1
                    with self.conn.cursor() as cur:
                        if time.time() - self.last_rules > 10:
                            self.rules = load_rules(cur)
                            self.last_rules = time.time()
                            cur.execute("""INSERT INTO settings (key, value, updated_at) VALUES ('alert_watcher', %s, now())
                                           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""",
                                        (Json({"pid": os.getpid(), "tick_sec": TICK_SEC}),))
                        if not self.started_logged:
                            states = ", ".join(f"{d}={s}" for d, (s, _) in self.states.items()) or "ยังไม่มีประวัติ"
                            self.out.info("watcher_start", "เริ่มระบบเฝ้าระวัง (alert_watcher)", f"สถานะกล้องล่าสุด: {states}", f"watcher_start:{int(time.time())}")
                            self.started_logged = True
                        self.check_devices(cur)
                        self.check_writer(cur)
                        if time.time() - self.last_rule_check >= RULE_EVERY_SEC:
                            self.check_rules(cur)
                            self.last_rule_check = time.time()
                        self.out.flush(cur)
                        self.tg.process(cur, self.rules, self.net.get("internet"))
                except psycopg2.Error as error:
                    if self.db_down_since is None:
                        self.db_down_since = time.time()
                        self.db_error = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
                        log.error("DB down: %s", self.db_error)
                    try:
                        if self.conn:
                            self.conn.close()
                    except Exception:
                        pass
                    self.conn = None
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 10)
                    continue
                time.sleep(TICK_SEC)
        except KeyboardInterrupt:
            log.info("STOP requested")
        finally:
            self.shutdown()

    def shutdown(self):
        self.mq.stop()
        if getattr(self, "lost_lock", False):
            return
        try:
            self.out.info("watcher_stop", "หยุดระบบเฝ้าระวัง (alert_watcher)", "alert ใหม่จะไม่ถูกสร้างจนกว่าจะรันใหม่", f"watcher_stop:{int(time.time())}", level="warning")
            if self.conn and not self.conn.closed:
                with self.conn.cursor() as cur:
                    self.out.flush(cur)
                    self.tg.last_run = 0
                    self.tg.process(cur, self.rules, self.net.get("internet"))
        except Exception as error:
            log.error("could not record stop: %s", error)
        log.info("STOP")


if __name__ == "__main__":
    if "--test-telegram" in sys.argv:
        if not (TELEGRAM_TOKEN and TELEGRAM_CHAT_ID):
            sys.exit("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env / .env.local")
        ok, _, error = telegram_send(format_alert(utcnow(), "info", "ทดสอบการแจ้งเตือน CIRA CORE", "ข้อความทดสอบจาก alert_watcher.py --test-telegram", None, None, "test"))
        print("sent" if ok else f"failed: {error}")
        sys.exit(0 if ok else 1)
    Watcher().run()
