#!/usr/bin/env python3
"""
mqtt_status.py  --  MQTT status topic -> device_status (PostgreSQL)

แยกจาก mqtt_to_db.py โดยสิ้นเชิง
  - เขียนทันทีทุกข้อความ (UPSERT) ไม่ batch ไม่รอ
  - client id ของตัวเอง, clean session (ไม่ต้องทนล่ม เพราะ heartbeat มาใหม่ทุก ~5 วินาที)
  - DB ล่ม -> ข้ามรอบนั้น แล้วต่อใหม่เองรอบหน้า

ตั้งค่า: DATABASE_URL (จำเป็น), MQTT_HOST, MQTT_PORT, MQTT_STATUS_TOPIC, STATUS_CLIENT_ID, LOG_DIR
"""

import json
import logging
import os
import sys
import time
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

DSN = os.environ["DATABASE_URL"]
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
STATUS_TOPIC = os.environ.get("MQTT_STATUS_TOPIC", "cira/fruit/status/")
CLIENT_ID = os.environ.get("STATUS_CLIENT_ID", "cira-status")
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(ROOT, "logs"))

os.makedirs(LOG_DIR, exist_ok=True)
log = logging.getLogger("mqtt_status")
log.setLevel("INFO")
_fmt = logging.Formatter(
    "%(asctime)s.%(msecs)03d | %(levelname)-7s | %(message)s", "%Y-%m-%d %H:%M:%S"
)
_fh = RotatingFileHandler(
    os.path.join(LOG_DIR, "mqtt_status.log"),
    maxBytes=2_000_000,
    backupCount=3,
    encoding="utf-8",
)
_fh.setFormatter(_fmt)
_sh = logging.StreamHandler(sys.stdout)
_sh.setFormatter(_fmt)
log.addHandler(_fh)
log.addHandler(_sh)

SQL = (
    "INSERT INTO device_status (device_id, source_type, state, detail, last_seen, updated_at) "
    "VALUES (%s,%s,%s,%s, now(), now()) "
    "ON CONFLICT (device_id) DO UPDATE SET "
    "source_type=EXCLUDED.source_type, state=EXCLUDED.state, "
    "detail=EXCLUDED.detail, last_seen=now(), "
    "updated_at = CASE WHEN device_status.state IS DISTINCT FROM EXCLUDED.state "
    "THEN now() ELSE device_status.updated_at END"
)

_conn = None
_err_ts = 0.0
_count = 0
_last_state = {}  # device_id -> state ล่าสุด (log เฉพาะตอนเปลี่ยน)


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


def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code.is_failure:
        log.error("MQTT_CONNECT_FAIL reason=%s", reason_code)
        return
    client.subscribe(STATUS_TOPIC + "#", qos=0)
    log.info("MQTT_UP broker=%s:%s topic=%s#", MQTT_HOST, MQTT_PORT, STATUS_TOPIC)


def on_disconnect(client, userdata, flags, reason_code, properties):
    log.warning("MQTT_DOWN reason=%s (จะต่อใหม่อัตโนมัติ)", reason_code)


def on_message(client, userdata, msg):
    global _err_ts, _count
    try:
        d = json.loads(msg.payload.decode("utf-8"))
        if not isinstance(d, dict):
            return
        dev = d.get("device_id")
        if not dev:
            return  # heartbeat ที่ skip: ทิ้งเงียบๆ
        conn = get_conn()
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    SQL,
                    (dev, d.get("source_type"), d.get("state"), Json(d.get("detail"))),
                )
        _count += 1
        st = d.get("state")
        if _last_state.get(dev) != st:  # log เฉพาะตอนสถานะเปลี่ยน
            log.info("STATE %s -> %s (heartbeats=%d)", dev, st, _count)
            _last_state[dev] = st
    except Exception as e:
        now = time.monotonic()
        if now - _err_ts > 10:
            first = (
                str(e).strip().splitlines()[0]
                if str(e).strip()
                else e.__class__.__name__
            )
            log.warning("STATUS_ERR %s", first)
            _err_ts = now
        drop_conn()


def main():
    log.info("START status writer topic=%s#", STATUS_TOPIC)
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=CLIENT_ID,
        clean_session=True,
    )
    client.reconnect_delay_set(min_delay=1, max_delay=15)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(MQTT_HOST, MQTT_PORT)
    client.loop_start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("STOP")
        client.loop_stop()
        client.disconnect()
        drop_conn()


if __name__ == "__main__":
    main()
