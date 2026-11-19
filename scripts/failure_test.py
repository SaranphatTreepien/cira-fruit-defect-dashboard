#!/usr/bin/env python3
"""
failure_test.py  --  check that no fruit event is lost when part of the pipeline goes down.

For each scenario it runs scripts/mqtt_sim.py (a fake CIRA CORE) with its own run id, breaks one
part while events are flowing, brings it back, then compares events sent with rows in fruit_events
for that run, and lists the alerts the watcher raised during the test.

  baseline   nothing breaks                      -> every event stored
  db         docker stop <db container> ~20 s     -> writer holds the batch, retries, nothing lost
  mqtt       docker stop <mqtt container> ~15 s   -> simulator queues QoS 1 messages, nothing lost
                                                    (real CIRA CORE MqttPub may NOT queue: test it in CORE too)

Needs: Docker containers up, scripts/mqtt_to_db.py running, alert_watcher running (npm run dev) to see alerts.
Stopping containers interrupts the DEV database / broker for a few seconds, so it asks for --yes.

  python scripts/failure_test.py --yes                  # baseline + db + mqtt
  python scripts/failure_test.py --yes --only db
Config: DATABASE_URL (.env.local), DB_CONTAINER (cira-db), MQTT_CONTAINER (cira-mqtt).
Manual cases (writer stopped, CORE crash, Internet down, ...) are in DOC/failure-test-checklist.md.
"""

import argparse
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import psycopg2

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
DB_CONTAINER = os.environ.get("DB_CONTAINER", "cira-db")
MQTT_CONTAINER = os.environ.get("MQTT_CONTAINER", "cira-mqtt")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def say(text):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {text}", flush=True)


def docker(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args)} failed: {result.stderr.strip()}")


def query(sql, params=(), wait=90):
    """Run one query, retrying while the DB comes back."""
    deadline = time.time() + wait
    while True:
        try:
            conn = psycopg2.connect(DSN, connect_timeout=3)
            try:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    return cur.fetchall()
            finally:
                conn.close()
        except psycopg2.OperationalError:
            if time.time() > deadline:
                raise
            time.sleep(2)


def stored(run):
    return query("SELECT count(*) FROM fruit_events WHERE raw->>'run' = %s", (run,))[0][0]


def run_sim(run, seconds, rate):
    """Start mqtt_sim.py in the background; returns (process, result dict filled when it ends)."""
    result = {}
    proc = subprocess.Popen(
        [sys.executable, os.path.join(BASE, "mqtt_sim.py"), "--run-id", run, "--duration", str(seconds),
         "--rate", str(rate), "--device", "FAILTEST", "--quiet"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
    )

    def read():
        for line in proc.stdout:
            m = re.search(r"SIM_SUMMARY run=\S+ events=(\d+)", line)
            if m:
                result["sent"] = int(m.group(1))
            elif "disconnected" in line or "connected" in line:
                say("  sim: " + line.strip().replace("[sim] ", ""))

    threading.Thread(target=read, daemon=True).start()
    return proc, result


def scenario(name, break_fn=None, fix_fn=None, sim_sec=60, rate=60, break_at=15, down_sec=20):
    run = f"failtest-{name}-{datetime.now(timezone.utc).strftime('%H%M%S')}"
    started = datetime.now(timezone.utc)
    say(f"=== {name}: run {run} · {rate}/min for {sim_sec} s")
    proc, result = run_sim(run, sim_sec, rate)
    try:
        if break_fn:
            time.sleep(break_at)
            say(f"  breaking: {break_fn.__doc__}")
            break_fn()
            time.sleep(down_sec)
            say(f"  restoring after {down_sec} s")
            fix_fn()
    finally:
        proc.wait(timeout=sim_sec + 120)
    time.sleep(1)
    sent = result.get("sent")
    if sent is None:
        say("  simulator gave no summary · FAIL")
        return False
    # the writer retries with backoff up to 15 s; give it time to drain
    deadline = time.time() + 60
    got = stored(run)
    while got < sent and time.time() < deadline:
        time.sleep(3)
        got = stored(run)
    alerts = query("""SELECT level, rule, title FROM alerts WHERE ts >= %s AND rule NOT IN ('device_online')
                      ORDER BY ts""", (started,))
    ok = got == sent
    say(f"  sent {sent} · stored {got} · lost {sent - got} · {'PASS' if ok else 'FAIL'}")
    for level, rule, title in alerts:
        say(f"  alert [{level}] {rule}: {title}")
    if break_fn and not alerts:
        say("  (no alert recorded: is alert_watcher running?)")
    return ok


def stop_db():
    """docker stop database"""
    docker("stop", DB_CONTAINER)


def start_db():
    docker("start", DB_CONTAINER)
    query("SELECT 1")


def stop_mqtt():
    """docker stop MQTT broker"""
    docker("stop", MQTT_CONTAINER)


def start_mqtt():
    docker("start", MQTT_CONTAINER)


def main():
    p = argparse.ArgumentParser(description="Pipeline failure test (DEV only)")
    p.add_argument("--yes", action="store_true", help="allow stopping the DEV containers")
    p.add_argument("--only", choices=["baseline", "db", "mqtt"])
    a = p.parse_args()
    if not a.yes:
        sys.exit("This stops the DEV database / MQTT containers for ~20 s. Re-run with --yes.")
    say("checking that mqtt_to_db.py is writing (10 s probe)...")
    if not scenario("probe", sim_sec=8, rate=60):
        sys.exit("Probe events were not stored: start scripts/mqtt_to_db.py first.")
    plan = {
        "baseline": lambda: scenario("baseline", sim_sec=30),
        "db": lambda: scenario("db", stop_db, start_db, down_sec=20),
        "mqtt": lambda: scenario("mqtt", stop_mqtt, start_mqtt, down_sec=15),
    }
    names = [a.only] if a.only else list(plan)
    results = {n: plan[n]() for n in names}
    say("=== summary: " + " · ".join(f"{n} {'PASS' if ok else 'FAIL'}" for n, ok in results.items()))
    say("test rows have raw->>'run' LIKE 'failtest-%' and device FAILTEST; delete them when done if you like.")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
