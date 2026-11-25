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
  python scripts/mqtt_sim.py --scenario demo                  # ~5 min scripted shift (see SCENARIOS)
  python scripts/mqtt_sim.py --scenario demo --loop --speed 2 # repeat forever, twice as fast

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

# Scripted shifts for demos: each phase lasts `sec` seconds; rate (fruit/min) and defect % move linearly
# from the start value to the end value ("rate": (a, b)). "beat": False = CORE silent (camera offline).
# "defects" weights the defect types; "conf" is the confidence range; "model" switches model_version.
# "fruits" weights the fruit types (only codes also listed in --fruits are used; default apple,orange), so the demo
# always shows both oranges and apples, with an apple-heavy lot in the defect spike.
SCENARIOS = {
    "demo": [
        {"name": "เปิดกะ / warm-up",          "sec": 20, "rate": (10, 40),   "defect": (8, 10),   "fruits": {"orange": 3, "apple": 2}},
        {"name": "เร่งไลน์ / ramp-up",         "sec": 60, "rate": (40, 120),  "defect": (10, 15),  "fruits": {"orange": 1, "apple": 1}},
        {"name": "ช่วงพีค / peak",             "sec": 60, "rate": (160, 180), "defect": (15, 18),  "fruits": {"orange": 3, "apple": 2}},
        {"name": "ล็อตเสีย / defect spike",    "sec": 45, "rate": (140, 140), "defect": (55, 70), "defects": {"rot": 6, "bruise": 2, "crack": 1}, "conf": (0.5, 0.8), "fruits": {"apple": 3, "orange": 1}},
        {"name": "สลับโมเดล / model switch",   "sec": 15, "rate": (140, 140), "defect": (20, 12), "model": "sim-v2", "conf": (0.8, 0.99)},
        {"name": "นิ่ง / steady",               "sec": 35, "rate": (150, 150), "defect": (10, 10), "model": "sim-v2", "conf": (0.8, 0.99)},
        {"name": "กล้องหลุด / camera offline", "sec": 30, "beat": False, "rate": (0, 0), "defect": (0, 0), "model": "sim-v2"},
        {"name": "กลับมา / recovery",           "sec": 20, "rate": (40, 120),  "defect": (10, 10), "model": "sim-v2", "conf": (0.8, 0.99), "restart": True},
        {"name": "ปิดกะ / wind-down",           "sec": 15, "rate": (120, 20),  "defect": (10, 8),  "model": "sim-v2", "conf": (0.8, 0.99)},
    ],
}


def scenario_at(phases, elapsed):
    """Phase index and its parameters at `elapsed` seconds (None when the scenario is over)."""
    t = elapsed
    for i, ph in enumerate(phases):
        if t < ph["sec"]:
            k = t / ph["sec"]
            lerp = lambda pair: pair[0] + (pair[1] - pair[0]) * k
            return i, ph, lerp(ph["rate"]), lerp(ph["defect"])
        t -= ph["sec"]
    return None

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
    p.add_argument("--scenario", choices=sorted(SCENARIOS), help="scripted shift; overrides --rate/--defect-pct/--switch-model/--stop-after")
    p.add_argument("--loop", action="store_true", help="with --scenario: start again when it ends (new run each time)")
    p.add_argument("--speed", type=float, default=1.0, help="with --scenario: play the timeline N times faster")
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
    phases = SCENARIOS.get(a.scenario) if a.scenario else None
    phase_idx = -1
    if phases:
        total = sum(p["sec"] for p in phases) / a.speed
        print(f"[sim] scenario={a.scenario} ({total:.0f} s{', loop' if a.loop else ''}) run={run} device={a.device}", flush=True)
    else:
        print(f"[sim] run={run} device={a.device} rate={a.rate}/min defect={a.defect_pct}% model={a.model}", flush=True)
    status("started")
    try:
        while not stop["now"]:
            now = time.monotonic()
            elapsed = now - started
            if a.duration and elapsed >= a.duration:
                break
            beating = not (a.stop_after and elapsed >= a.stop_after)
            rate, defect_pct, model, conf, weights, fruit_w = a.rate, a.defect_pct, None, (0.55, 0.99), None, None
            if phases:
                at = scenario_at(phases, elapsed * a.speed)
                if at is None:
                    if not a.loop:
                        break
                    status("end")
                    run = datetime.now(timezone.utc).strftime("sim%Y%m%dT%H%M%S")
                    started, track, phase_idx = now, 0, -1
                    print(f"[sim] scenario loop: new run={run}", flush=True)
                    status("started")
                    continue
                idx, ph, rate, defect_pct = at
                beating = ph.get("beat", True)
                model = ph.get("model", a.model)
                conf = ph.get("conf", conf)
                weights = ph.get("defects")
                fruit_w = {f: w for f, w in ph.get("fruits", {"orange": 1, "apple": 1}).items() if f in fruits} or None
                if idx != phase_idx:
                    phase_idx = idx
                    print(f"[sim] PHASE {idx + 1}/{len(phases)} {ph['name']} · {ph['rate'][0]:.0f}->{ph['rate'][1]:.0f}/min · defect {ph['defect'][0]:.0f}->{ph['defect'][1]:.0f}%", flush=True)
                    if ph.get("restart"):
                        status("started")
                gap = 60.0 / rate if rate > 0 else 1e9
                next_fruit = min(next_fruit, now + gap)
            if now >= next_beat:
                if beating:
                    status("playing")
                next_beat = now + 2
            if beating and now >= next_fruit:
                next_fruit = now + random.uniform(0.6, 1.4) * gap
                track += 1
                if model is None:
                    model = a.switch_model if a.switch_model and elapsed >= a.switch_after else a.model
                defect = random.random() * 100 < defect_pct
                defect_type = None
                if defect:
                    defect_type = random.choices(list(weights), weights=list(weights.values()))[0] if weights else random.choice(DEFECTS)
                ts = datetime.now(timezone.utc)
                ev = {
                    "event_id": f"{run}-{track}",
                    "run": run,
                    "track_id": track,
                    "timestamp": ts.isoformat(),
                    "fruit_type": random.choices(list(fruit_w), weights=list(fruit_w.values()))[0] if fruit_w else random.choice(fruits),
                    "external_result": "defect" if defect else "good",
                    "defect_type": defect_type,
                    "nir_result": "not_supported",
                    "confidence": round(random.uniform(*conf), 2),
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
