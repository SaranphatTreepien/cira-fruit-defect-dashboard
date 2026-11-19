#!/usr/bin/env python3
"""
mqtt_sim.py  --  pretend to be CIRA CORE: send heartbeats + fruit events over MQTT.

Use it to demo / develop the dashboard without opening CIRA CORE. It publishes exactly what the
real flow publishes, so everything after the broker (mqtt_to_db.py, watcher, web) runs for real:
  cira/fruit/status/<device>   {"device_id", "source_type", "state", "detail"}   every 2 s
  cira/fruit/events            {"event_id", "run", "track_id", "timestamp", ...}  QoS 1

Examples
  python scripts/mqtt_sim.py                                  # 30 fruit/min until Ctrl+C
  python scripts/mqtt_sim.py --rate 120 --defect-pct 60       # busy line, many defects
  python scripts/mqtt_sim.py --duration 120 --switch-model sim-v2 --switch-after 60
  python scripts/mqtt_sim.py --bad-pct 5 --dup-pct 10         # test reject log + dedup
  python scripts/mqtt_sim.py --stop-after 30 --duration 90    # heartbeat stops at 30 s (device offline)

Stop with Ctrl+C: it sends state "end" so the dashboard closes the run.
Prints one summary line at the end (run id, sent counts) that scripts/failure_test.py reads.
Config: MQTT_HOST, MQTT_PORT, MQTT_TOPIC, MQTT_STATUS_TOPIC (.env.local or environment).
"""

import argparse
import json
import os
import random
import signal
import sys
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


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
MQTT_HOST = os.environ.get("MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
TOPIC = os.environ.get("MQTT_TOPIC", "cira/fruit/events")
STATUS_TOPIC = os.environ.get("MQTT_STATUS_TOPIC", "cira/fruit/status/")
DEFECTS = ["bruise", "rot", "crack"]

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def parse_args():
    p = argparse.ArgumentParser(description="Simulate CIRA CORE over MQTT")
    p.add_argument("--device", default="SIM_01", help="device_id for heartbeats (default SIM_01)")
    p.add_argument("--rate", type=float, default=30, help="fruit per minute (default 30)")
    p.add_argument("--defect-pct", type=float, default=30, help="share of defect results in %% (default 30)")
    p.add_argument("--fruits", default="apple,orange", help="comma list of fruit_type codes")
    p.add_argument("--model", default="sim-v1", help="model_version to put in events")
    p.add_argument("--source", default="mock", choices=["mock", "quick", "team"], help="model_source")
    p.add_argument("--switch-model", help="change model_version to this after --switch-after seconds")
    p.add_argument("--switch-after", type=float, default=60)
    p.add_argument("--duration", type=float, default=0, help="seconds to run, 0 = until Ctrl+C")
    p.add_argument("--stop-after", type=float, default=0, help="stop heartbeats after N s (simulates CORE crash)")
    p.add_argument("--bad-pct", type=float, default=0, help="%% of messages sent broken (reject log test)")
    p.add_argument("--dup-pct", type=float, default=0, help="%% of fruit sent twice with a new event_id (dedup test)")
    p.add_argument("--run-id", help="run id (default: UTC time like CIRA CORE)")
    p.add_argument("--quiet", action="store_true", help="no line per event")
    return p.parse_args()


def main():
    a = parse_args()
    run = a.run_id or datetime.now(timezone.utc).strftime("sim%Y%m%dT%H%M%S")
    fruits = [f.strip() for f in a.fruits.split(",") if f.strip()]
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"cira-sim-{os.getpid()}", clean_session=True)
    client.max_queued_messages_set(0)  # keep QoS 1 messages queued while the broker is away
    connected = {"up": False}
    client.on_connect = lambda c, u, f, rc, p: connected.update(up=not rc.is_failure) or print(f"[sim] MQTT {'connected' if not rc.is_failure else 'refused'} {MQTT_HOST}:{MQTT_PORT}", flush=True)
    stop = {"now": False, "closing": False}
    client.on_disconnect = lambda c, u, f, rc, p: connected.update(up=False) or (stop["closing"] or print("[sim] MQTT disconnected (will retry)", flush=True))
    client.reconnect_delay_set(1, 5)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=10)
    client.loop_start()

    signal.signal(signal.SIGINT, lambda *_: stop.update(now=True))
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, lambda *_: stop.update(now=True))

    def status(state):
        body = {"device_id": a.device, "source_type": "simulator", "state": state, "detail": {"run": run, "sim": True}}
        client.publish(STATUS_TOPIC + a.device, json.dumps(body), qos=0)

    sent = {"events": 0, "bad": 0, "dup": 0}
    started = time.monotonic()
    next_fruit = started
    next_beat = started
    track = 0
    gap = 60.0 / a.rate if a.rate > 0 else 1e9
    print(f"[sim] run={run} device={a.device} rate={a.rate}/min defect={a.defect_pct}% model={a.model}", flush=True)
    status("started")
    try:
        while not stop["now"]:
            now = time.monotonic()
            elapsed = now - started
            if a.duration and elapsed >= a.duration:
                break
            beating = not (a.stop_after and elapsed >= a.stop_after)
            if now >= next_beat:
                if beating:
                    status("playing")
                next_beat = now + 2
            if beating and now >= next_fruit:
                next_fruit = now + random.uniform(0.6, 1.4) * gap
                track += 1
                model = a.switch_model if a.switch_model and elapsed >= a.switch_after else a.model
                defect = random.random() * 100 < a.defect_pct
                ts = datetime.now(timezone.utc)
                ev = {
                    "event_id": f"{run}-{track}",
                    "run": run,
                    "track_id": track,
                    "timestamp": ts.isoformat(),
                    "fruit_type": random.choice(fruits),
                    "external_result": "defect" if defect else "good",
                    "defect_type": random.choice(DEFECTS) if defect else None,
                    "nir_result": "not_supported",
                    "confidence": round(random.uniform(0.55, 0.99), 2),
                    "camera_view": "top",
                    "model_version": model,
                    "model_source": a.source,
                }
                if a.bad_pct and random.random() * 100 < a.bad_pct:
                    broken = random.choice([
                        b"{not json",
                        json.dumps({**ev, "event_id": ""}).encode(),
                        json.dumps({**ev, "external_result": "maybe"}).encode(),
                        json.dumps({**ev, "timestamp": "yesterday"}).encode(),
                    ])
                    client.publish(TOPIC, broken, qos=1)
                    sent["bad"] += 1
                    if not a.quiet:
                        print(f"[sim] BAD  #{track} {broken[:60]!r}", flush=True)
                    continue
                client.publish(TOPIC, json.dumps(ev), qos=1)
                sent["events"] += 1
                if not a.quiet:
                    print(f"[sim] SENT #{track} {ev['fruit_type']:<6} {ev['external_result']:<6} {ev['defect_type'] or '':<6} conf={ev['confidence']} model={model}{'' if connected['up'] else '  (queued: broker down)'}", flush=True)
                if a.dup_pct and random.random() * 100 < a.dup_pct:
                    again = {**ev, "event_id": f"{ev['event_id']}-again", "timestamp": datetime.now(timezone.utc).isoformat()}
                    client.publish(TOPIC, json.dumps(again), qos=1)
                    sent["dup"] += 1
                    if not a.quiet:
                        print(f"[sim] DUP  #{track} same track_id, new event_id (writer should drop it)", flush=True)
            time.sleep(0.05)
    finally:
        status("end")
        deadline = time.monotonic() + 10
        while client.want_write() and time.monotonic() < deadline:  # flush queued messages
            time.sleep(0.1)
        time.sleep(0.5)
        stop["closing"] = True
        client.loop_stop()
        client.disconnect()
        print(f"SIM_SUMMARY run={run} events={sent['events']} bad={sent['bad']} dup={sent['dup']} seconds={time.monotonic() - started:.0f}", flush=True)


if __name__ == "__main__":
    main()
