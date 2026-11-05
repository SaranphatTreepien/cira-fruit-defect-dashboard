#!/usr/bin/env python3
"""
mqtt_to_db.py v3  --  MQTT (Mosquitto) -> PostgreSQL local, แบบ batch + ทนล่ม + สถานะอุปกรณ์

หลักการ
  1. session ถาวร (client id ตายตัว + clean_session=False + QoS 1)
     -> ตัวรับล่ม broker เก็บข้อความไว้ให้
  2. event ผลไม้ (topic cira/fruit/events): สะสมเป็นชุด (batch)
     flush เมื่อครบ BATCH_SIZE หรือครบ FLUSH_SEC วินาที
  3. INSERT ทั้งชุดใน transaction เดียว (ON CONFLICT DO NOTHING)
     แล้ว "ack" ให้ broker หลัง commit สำเร็จเท่านั้น
  4. DB ล่ม -> ไม่ ack, ต่อใหม่แบบ backoff, ลองชุดเดิมซ้ำ (ซ้ำไม่เป็นไรเพราะ event_id)
  5. ข้อความเสีย (JSON พัง/ไม่มี event_id ฯลฯ) -> ack แล้วแยกทิ้ง + log (ไม่ให้วนค้าง)
  6. สถานะอุปกรณ์ (topic cira/fruit/status/#): เขียนลง device_status ทันที ไม่ผ่าน batch
     ใช้ connection แยกจาก event (ไม่ปนกับ transaction ของ batch)

ตั้งค่าผ่าน .env.local หรือ environment variable (ทุกตัวมีค่าเริ่มต้น ยกเว้น DATABASE_URL)
  DATABASE_URL, MQTT_HOST, MQTT_PORT, MQTT_TOPIC, MQTT_STATUS_TOPIC, MQTT_CLIENT_ID,
  BATCH_SIZE, FLUSH_SEC, LOG_LEVEL, LOG_EVENTS (1/0), LOG_DIR
"""

import json
import logging
import os
import sys
import threading
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
import subprocess
import paho.mqtt.client as mqtt
import psycopg2
from psycopg2.extras import Json, execute_values

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

DSN = os.environ["DATABASE_URL"]
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
TOPIC = os.environ.get("MQTT_TOPIC", "cira/fruit/events")
STATUS_TOPIC = os.environ.get("MQTT_STATUS_TOPIC", "cira/fruit/status/")
CLIENT_ID = os.environ.get("MQTT_CLIENT_ID", "cira-writer")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "50"))
FLUSH_SEC = float(os.environ.get("FLUSH_SEC", "1.0"))
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
LOG_EVENTS = os.environ.get("LOG_EVENTS", "1") == "1"
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(ROOT, "logs"))
STATS_EVERY = 30  # วินาที

# ---------------------------------------------------------------- logging
os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("mqtt_to_db")
log.setLevel(LOG_LEVEL)
_fmt = logging.Formatter(
    "%(asctime)s.%(msecs)03d | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S"
)
_fh = RotatingFileHandler(
    os.path.join(LOG_DIR, "mqtt_to_db.log"),
    maxBytes=5_000_000,
    backupCount=5,
    encoding="utf-8",
)
_fh.setFormatter(_fmt)
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(_fmt)
log.addHandler(_fh)
log.addHandler(_sh)

# ---------------------------------------------------------------- state
lock = threading.Lock()
buf = []  # [(ev, mid, qos, gen)]
buf_first_ts = 0.0  # เวลาที่ข้อความแรกของชุดเข้า buffer
gen = 0  # เลขรุ่นของการเชื่อมต่อ MQTT (เพิ่มทุกครั้งที่ connect)
syslog_q = []  # ข้อความเสียที่รอเขียนลง system_logs
stopping = False
_conn = None  # connection ของ event (main thread)
_status_conn = None  # connection ของสถานะ (MQTT callback thread)
stats = {"recv": 0, "inserted": 0, "dup": 0, "bad": 0, "batches": 0, "status": 0}
_last_stats = (0, 0, 0, 0, 0, 0)
_status_err_ts = 0.0  # กัน log STATUS_ERR รัว

INSERT_SQL = (
    "INSERT INTO fruit_events (event_id, ts, fruit_type, external_result, defect_type, "
    "nir_result, confidence, camera_view, model_version, model_source, raw, track_id) VALUES %s "
    "ON CONFLICT (event_id) DO NOTHING RETURNING event_id"
)

STATUS_SQL = (
    "INSERT INTO device_status (device_id, source_type, state, detail, last_seen, updated_at) "
    "VALUES (%s,%s,%s,%s, now(), now()) "
    "ON CONFLICT (device_id) DO UPDATE SET "
    "source_type=EXCLUDED.source_type, state=EXCLUDED.state, "
    "detail=EXCLUDED.detail, last_seen=now(), "
    "updated_at = CASE WHEN device_status.state IS DISTINCT FROM EXCLUDED.state "
    "THEN now() ELSE device_status.updated_at END"
)


# ---------------------------------------------------------------- DB (event)
def get_conn():
    global _conn
    if _conn is None or _conn.closed:
        _conn = psycopg2.connect(DSN, connect_timeout=3)
        log.info("DB_UP connected")
    return _conn


def drop_conn():
    global _conn
    try:
        if _conn is not None:
            _conn.close()
    except Exception:
        pass
    _conn = None


# ---------------------------------------------------------------- DB (status)
def get_status_conn():
    global _status_conn
    if _status_conn is None or _status_conn.closed:
        _status_conn = psycopg2.connect(DSN, connect_timeout=3)
        log.info("DB_STATUS_UP connected")
    return _status_conn


def drop_status_conn():
    global _status_conn
    try:
        if _status_conn is not None:
            _status_conn.close()
    except Exception:
        pass
    _status_conn = None


def load_lookups(cur):
    cur.execute("SELECT code FROM fruit_types")
    fruit = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT code FROM defect_types")
    defect = {r[0] for r in cur.fetchall()}
    cur.execute("SELECT model_version FROM models")
    model = {r[0] for r in cur.fetchall()}
    return fruit, defect, model


def build_row(ev, lk):
    """ค่า lookup ที่ไม่รู้จัก -> NULL (ของเดิมยังอยู่ใน raw) ไม่ปฏิเสธทั้งแถว"""
    fruit_ok, defect_ok, model_ok = lk
    notes = []

    def pick(key, allowed):
        v = ev.get(key)
        if v is not None and v not in allowed:
            notes.append(f"{key}={v!r}")
            return None
        return v

    row = (
        ev["event_id"],
        ev["timestamp"],
        pick("fruit_type", fruit_ok),
        ev["external_result"],
        pick("defect_type", defect_ok),
        ev.get("nir_result"),
        ev.get("confidence"),
        ev.get("camera_view"),
        pick("model_version", model_ok),
        ev.get("model_source"),
        Json(ev),
        ev.get("track_id"),
    )
    return row, notes


def write_batch(conn, evs):
    """INSERT ทั้งชุดใน transaction เดียว -> (set ของ event_id ที่เข้าจริง, notes)"""
    with conn:
        with conn.cursor() as cur:
            lk = load_lookups(cur)
            rows, notes = [], []
            for ev in evs:
                r, n = build_row(ev, lk)
                rows.append(r)
                for x in n:
                    notes.append((ev["event_id"], x))
            res = execute_values(cur, INSERT_SQL, rows, fetch=True)
    return {r[0] for r in res}, notes


# ---------------------------------------------------------------- parse
def parse(payload):
    try:
        ev = json.loads(payload.decode("utf-8"))
    except Exception as e:
        raise ValueError(f"invalid_json ({e.__class__.__name__})")
    if not isinstance(ev, dict):
        raise ValueError("not_a_json_object")
    eid = ev.get("event_id")
    if not isinstance(eid, str) or not eid.strip():
        raise ValueError("missing_event_id")
    ts = ev.get("timestamp")
    if not ts:
        raise ValueError("missing_timestamp")
    try:
        datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("bad_timestamp")
    if ev.get("external_result") not in ("good", "defect"):
        raise ValueError("bad_external_result")
    if ev.get("confidence") is not None:
        try:
            ev["confidence"] = float(ev["confidence"])
        except (TypeError, ValueError):
            raise ValueError("bad_confidence")
    return ev


def reject(reason, payload):
    stats["bad"] += 1
    shown = payload[:200].decode("utf-8", "replace")
    log.warning("BAD_MESSAGE reason=%s payload=%s", reason, shown)
    if len(syslog_q) < 1000:
        syslog_q.append(f"BAD_MESSAGE reason={reason} payload={shown}")


def drain_syslog():
    """เขียนข้อความเสียลง system_logs แบบ best-effort (DB ล่มก็แค่รอรอบหน้า)"""
    if not syslog_q:
        return
    try:
        conn = get_conn()
        with conn:
            with conn.cursor() as cur:
                for m in list(syslog_q):
                    cur.execute(
                        "INSERT INTO system_logs (level, source, message) VALUES ('warning','mqtt_to_db',%s)",
                        (m,),
                    )
        syslog_q.clear()
    except psycopg2.Error:
        drop_conn()


# ---------------------------------------------------------------- flush
def ack_items(client, items):
    acked = skipped = 0
    for _, mid, qos, g in items:
        if g != gen:  # คนละการเชื่อมต่อ: broker จะส่งซ้ำเอง ไม่ต้อง ack
            skipped += 1
            continue
        if qos > 0 and mid is not None:
            client.ack(mid, qos)
            acked += 1
    return acked, skipped


def flush(client, items, final=False):
    """เขียนชุดข้อความลง DB แล้ว ack -- วนลองใหม่จนสำเร็จ (ยกเว้นตอนปิดโปรแกรม)"""
    evs = [i[0] for i in items]
    backoff = 1.0
    while True:
        try:
            conn = get_conn()
            t0 = time.perf_counter()
            bad = []
            try:
                inserted, notes = write_batch(conn, evs)
            except (psycopg2.OperationalError, psycopg2.InterfaceError):
                raise
            except psycopg2.Error as e:
                # ชุดนี้มีแถวที่ DB ไม่ยอมรับ -> แยกทีละแถว คัดแถวเสียออก
                log.warning(
                    "BATCH_FALLBACK size=%d error=%s",
                    len(evs),
                    str(e).strip().splitlines()[0],
                )
                inserted, notes = set(), []
                for ev in evs:
                    try:
                        i1, n1 = write_batch(conn, [ev])
                        inserted |= i1
                        notes += n1
                    except (psycopg2.OperationalError, psycopg2.InterfaceError):
                        raise
                    except psycopg2.Error as e1:
                        bad.append((ev, str(e1).strip().splitlines()[0]))
            ms = (time.perf_counter() - t0) * 1000

            bad_ids = {b[0]["event_id"] for b in bad}
            for ev, why in bad:
                reject(f"db_rejected: {why}", json.dumps(ev).encode())
            for eid, n in notes:
                log.warning(
                    "UNKNOWN_LOOKUP event_id=%s %s -> NULL (ของเดิมอยู่ใน raw)", eid, n
                )

            if LOG_EVENTS:
                for ev in evs:
                    eid = ev["event_id"]
                    if eid in bad_ids:
                        continue
                    state = "NEW" if eid in inserted else "DUP"
                    log.info(
                        "EVENT %s id=%s fruit=%s result=%s defect=%s conf=%s cam=%s model=%s/%s",
                        state,
                        eid,
                        ev.get("fruit_type"),
                        ev.get("external_result"),
                        ev.get("defect_type"),
                        ev.get("confidence"),
                        ev.get("camera_view"),
                        ev.get("model_version"),
                        ev.get("model_source"),
                    )

            acked, skipped = ack_items(client, items)
            n_new = len(inserted)
            n_dup = len(evs) - n_new - len(bad)
            stats["inserted"] += n_new
            stats["dup"] += n_dup
            stats["batches"] += 1
            log.info(
                "BATCH ok size=%d new=%d dup=%d bad=%d acked=%d ack_skipped=%d db_ms=%.1f",
                len(evs),
                n_new,
                n_dup,
                len(bad),
                acked,
                skipped,
                ms,
            )
            return
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            drop_conn()
            msg = (
                str(e).strip().splitlines()[0]
                if str(e).strip()
                else e.__class__.__name__
            )
            if final:
                log.error(
                    "DB_DOWN ระหว่างปิดโปรแกรม: %d ข้อความยังไม่ ack (broker จะส่งซ้ำตอนเปิดใหม่): %s",
                    len(evs),
                    msg,
                )
                return
            log.error("DB_DOWN size=%d retry_in=%.0fs error=%s", len(evs), backoff, msg)
            time.sleep(backoff)
            backoff = min(backoff * 2, 15.0)


# ---------------------------------------------------------------- MQTT callbacks
def on_connect(client, userdata, flags, reason_code, properties):
    global gen
    if reason_code.is_failure:
        log.error("MQTT_CONNECT_FAIL reason=%s", reason_code)
        return
    with lock:
        gen += 1
        buf.clear()  # ข้อความที่ค้างจากการเชื่อมต่อเก่า broker จะส่งซ้ำให้เอง
    client.unsubscribe(STATUS_TOPIC + "#")  # session ถาวรอาจจำของเก่าไว้ที่ broker
    client.subscribe(TOPIC, qos=1)
    log.info(
        "MQTT_UP broker=%s:%s topic=%s status=%s# client_id=%s session_present=%s",
        MQTT_HOST,
        MQTT_PORT,
        TOPIC,
        STATUS_TOPIC,
        CLIENT_ID,
        getattr(flags, "session_present", "?"),
    )


def on_disconnect(client, userdata, flags, reason_code, properties):
    log.warning("MQTT_DOWN reason=%s (จะต่อใหม่อัตโนมัติ)", reason_code)


def on_message(client, userdata, msg):
    global buf_first_ts

    stats["recv"] += 1

    try:
        data = json.loads(msg.payload.decode("utf-8"))
    except Exception as e:
        reject("invalid_json (%s)" % e.__class__.__name__, msg.payload)
        if msg.qos > 0:
            client.ack(msg.mid, msg.qos)
        return

    raw_list = (
        data["events"]
        if isinstance(data, dict) and isinstance(data.get("events"), list)
        else [data]
    )

    good = []
    for item in raw_list:
        try:
            good.append(parse(json.dumps(item).encode("utf-8")))
        except ValueError as e:
            reject(str(e), json.dumps(item).encode("utf-8"))

    if not good:
        if msg.qos > 0:
            client.ack(msg.mid, msg.qos)
        return

    with lock:
        if not buf:
            buf_first_ts = time.monotonic()
        # ack ครั้งเดียวต่อ message: ผูกกับ event ตัวสุดท้ายของชุด
        for i, ev in enumerate(good):
            last = i == len(good) - 1
            buf.append((ev, msg.mid if last else None, msg.qos if last else 0, gen))


# ---------------------------------------------------------------- main
def log_stats(force=False):
    global _last_stats
    cur = (
        stats["recv"],
        stats["inserted"],
        stats["dup"],
        stats["bad"],
        stats["batches"],
        stats["status"],
    )
    if force or cur != _last_stats:
        with lock:
            pending = len(buf)
        log.info(
            "STATS recv=%d inserted=%d dup=%d bad=%d batches=%d status=%d pending=%d",
            *cur,
            pending,
        )
        _last_stats = cur


STATUS_SCRIPT = os.path.join(BASE, "mqtt_status.py")
status_proc = None


def ensure_status_proc():
    """เปิด mqtt_status.py เป็นโปรเซสลูก ถ้าดับจะเปิดใหม่ให้เอง"""
    global status_proc
    if status_proc is None or status_proc.poll() is not None:
        if status_proc is not None:
            log.warning("STATUS_PROC exited code=%s -> restart", status_proc.returncode)
        status_proc = subprocess.Popen([sys.executable, STATUS_SCRIPT])
        log.info("STATUS_PROC started pid=%d", status_proc.pid)


def stop_status_proc():
    if status_proc is not None and status_proc.poll() is None:
        status_proc.terminate()
        try:
            status_proc.wait(timeout=3)
        except Exception:
            status_proc.kill()


def main():
    global stopping
    log.info(
        "START v3 batch_size=%d flush_sec=%.1f log_dir=%s log_events=%s",
        BATCH_SIZE,
        FLUSH_SEC,
        LOG_DIR,
        LOG_EVENTS,
    )
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=CLIENT_ID,
        clean_session=False,
        manual_ack=True,
    )
    client.reconnect_delay_set(min_delay=1, max_delay=15)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(MQTT_HOST, MQTT_PORT)
    client.loop_start()
    ensure_status_proc()
    last_chk = time.monotonic()
    last_stats_t = time.monotonic()
    try:
        while True:
            time.sleep(0.05)
            with lock:
                n = len(buf)
                age = time.monotonic() - buf_first_ts if n else 0.0
                take = n >= BATCH_SIZE or (n > 0 and age >= FLUSH_SEC)
                items = buf[:BATCH_SIZE] if take else []
                if take:
                    del buf[: len(items)]
            if items:
                flush(client, items)
            drain_syslog()
            if time.monotonic() - last_chk >= 5:
                ensure_status_proc()
                last_chk = time.monotonic()
            if time.monotonic() - last_stats_t >= STATS_EVERY:
                log_stats()
                last_stats_t = time.monotonic()
    except KeyboardInterrupt:
        stopping = True
        log.info("STOP รับสัญญาณปิดโปรแกรม กำลัง flush ที่ค้างอยู่")
        with lock:
            items = list(buf)
            buf.clear()
        if items:
            flush(client, items, final=True)
        log_stats(force=True)
        client.loop_stop()
        client.disconnect()
        drop_conn()
        drop_status_conn()
        stop_status_proc()
        log.info("STOPPED")


if __name__ == "__main__":
    main()
