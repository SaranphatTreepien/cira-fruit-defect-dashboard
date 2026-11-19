# Failure test checklist (DEV)

Goal: when part of the pipeline goes down, **no fruit event is lost** and **someone is told** (alert in
the dashboard + Telegram). Pipeline: CIRA CORE → MQTT (`cira-mqtt`) → `scripts/mqtt_to_db.py` →
PostgreSQL (`cira-db`) → dashboard; `scripts/alert_watcher.py` watches all of it.

Run before a demo and after any change to the scripts. Write the date, result and notes in the table at
the end.

## Before you start

- [ ] `docker ps` shows `cira-db`, `cira-mqtt` running
- [ ] `npm run dev` is running (web + alert_watcher + telegram_bot)
- [ ] `python scripts/mqtt_to_db.py` is running in its own terminal
- [ ] Dashboard open on **System Status** and **Alert & Reports**

## Automatic (script)

```powershell
python scripts/failure_test.py --yes
```

| Scenario | What it does | Pass when |
|---|---|---|
| baseline | simulator 30 s, nothing breaks | sent = stored |
| db | `docker stop cira-db` for 20 s while events flow | sent = stored; alerts `db_down` (written when DB is back) and usually `writer_down` |
| mqtt | `docker stop cira-mqtt` for 15 s | sent = stored (simulator queues QoS 1); alert `mqtt_down` (critical) + `mqtt_up` |

Test rows use `raw->>'run' LIKE 'failtest-%'` and device `FAILTEST`.

## Manual

Use the simulator for the data (`python scripts/mqtt_sim.py --rate 60`) unless the case says CIRA CORE.

| # | Case | How | Expected |
|---|---|---|---|
| M1 | Writer stopped | Ctrl+C `mqtt_to_db.py` for 60 s, start it again | `writer_down` (critical) within ~15 s; after restart the broker delivers the queued messages (persistent session `cira-writer`), sent = stored |
| M2 | CIRA CORE crashes / is closed | close CIRA CORE while it runs (or `mqtt_sim.py --stop-after 30 --duration 90`) | device goes `offline` after 6 s, alert "กล้อง … หยุดทำงาน"; the run closes on **Runs & Models** |
| M3 | Running but no fruit | CORE playing with an empty belt (or sim `--rate 0`) | after `no_events.after_sec` alert "ทำงานอยู่แต่ไม่มีผลไม้เข้า" |
| M4 | Internet down | unplug network / turn off Wi-Fi 1 min | `internet_down` (warning); Telegram messages wait and are sent when back; local dashboard keeps working |
| M5 | Watcher stopped | stop `npm run dev` | Alert page shows "alert_watcher ไม่ทำงาน"; on restart `watcher_start` info |
| M6 | Broken payloads | `mqtt_sim.py --bad-pct 20` | System Status → คุณภาพข้อมูล lists each one with its reason; nothing stored for them |
| M7 | Same fruit sent twice | `mqtt_sim.py --dup-pct 30` | System Status shows "ผลไม้ส่งซ้ำ (ทิ้ง)"; counts on Live not inflated |
| M8 | Model switched | change model in CIRA CORE (or sim `--switch-model sim-v2 --switch-after 30`) | warning "โมเดลเปลี่ยน: … → …"; both models on **Runs & Models** |
| M9 | CORE MqttPub while broker down | in CIRA CORE: stop `cira-mqtt` 15 s while the flow runs | **find out**: does MqttPub queue or drop? If it drops, events in that window are lost (note it for team C) |
| M10 | Power loss of the PC | restart Windows while the sim runs | after boot: containers restart (`restart: unless-stopped`), start `npm run dev` + writer, data before the cut is in the DB |

## False positive / false negative (model, not pipeline)

Done with team B on labelled images, not with the dashboard:

- [ ] 50–100 site images per class (`apple_good`, `apple_defect`, `orange_good`, `orange_defect`)
- [ ] Run them through the model in CIRA CORE, record predicted vs true label
- [ ] Count FP (good → defect) and FN (defect → good) per class; precision / recall
- [ ] Put precision / recall / threshold into the `models` table so **Fruit Profiles** and **Runs & Models** show them

## Results

| Date | Case | Result | Notes |
|---|---|---|---|
| | | | |
