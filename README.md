# CIRA CORE Fruit Defect Sorter & Counter — Dashboard

Dashboard สำหรับระบบคัดแยกและนับผลไม้ (แอปเปิล / ส้ม) ที่ตรวจด้วยโมเดลใน **CIRA CORE**
รับผลการตรวจผ่าน MQTT เก็บลง PostgreSQL แล้วแสดงผลแบบ real-time พร้อม log, รายงาน, alert และ Telegram

> โปรเจกต์ทีม 4 คน: A Data / B Training / C Real-time / **D Platform & Dashboard** (repo นี้)

## Features

- **Live** — สถานะเครื่อง, ผลคัดแยกดี/เสียแบบ real-time, ความหน่วง CIRA → DB → จอ
- **Dashboard Log** — ค้นหา/กรองทุก event, กราฟแนวโน้ม, export CSV
- **Runs & Models** — รอบการทำงานตัดอัตโนมัติจากสถานะเครื่อง และเทียบผลแต่ละ `model_version`
- **Alert & Reports** — กล้องหยุด, defect rate สูง, ไม่มีผลไม้เข้า, MQTT/DB/Internet ล่ม, โมเดลเปลี่ยน · รายงานรายวัน · AI สรุป (Gemini)
- **Telegram** — ส่ง alert + รายงานประจำวันอัตโนมัติ และ bot เมนูถามสถานะ/ยอด/คาดการณ์
- **System Status** — สุขภาพระบบ และคุณภาพข้อมูล (payload ที่ถูกปฏิเสธ, ผลไม้ส่งซ้ำ, ค่าที่ไม่รู้จัก)
- **Login** — role `admin` / `viewer`, บันทึกว่าใครรับทราบ alert
- **ตัวจำลอง CIRA CORE** — พัฒนาและ demo ได้โดยไม่ต้องเปิด CORE

> CIRA CORE เป็นโปรแกรมแบบ node-based: Start/Stop, เปลี่ยนโมเดล, threshold และกล้อง ต้องทำใน CIRA CORE เอง
> Dashboard **รับข้อมูลและดักสถานะ** เท่านั้น ไม่สั่งงาน CORE

## Architecture

```
CIRA CORE / scripts/mqtt_sim.py
   │  MQTT  cira/fruit/events            (1 event ต่อผลไม้, QoS 1)
   │        cira/fruit/status/<device>   (heartbeat ทุก ~2 วิ)
   ▼
Mosquitto (cira-mqtt :1883)
   ▼
scripts/mqtt_to_db.py  ──(+ mqtt_status.py)──▶  PostgreSQL 16 (cira-db :15432)
   batch insert, ack หลัง commit, กันซ้ำ, ทนล่ม            │
                                                           ├──▶ Next.js Dashboard (:3000)
scripts/alert_watcher.py ── alerts / Telegram / daily ────┤
scripts/telegram_bot.py  ── menu bot + Gemini ────────────┘
```

## Tech stack

| ส่วน | เทคโนโลยี |
|---|---|
| Web | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, lucide-react |
| API | Next.js Route Handlers + `pg` |
| Database | PostgreSQL 16 (Docker) |
| Messaging | Eclipse Mosquitto 2 (MQTT) |
| Pipeline / Alert | Python 3.12+ (`paho-mqtt`, `psycopg2`) |
| แจ้งเตือน / AI | Telegram Bot API, Google Gemini |

## Project structure

```
app/
  [[...slug]]/page.tsx     หน้าเว็บทั้งหมด (Live, Log, Runs, Alerts, System, Profiles, Users, Team, Login)
  api/                     REST API (ทุก route ต้อง login ยกเว้น /api/auth/*)
src/
  db/pool.ts               PostgreSQL connection pool
  lib/auth.ts              password hash, session, requireUser()
  lib/demo.ts              บัญชี demo ในหน้า login
  lib/logQuery.ts          ตัวกรองของหน้า Log
db/
  schema_core.sql          ตารางหลัก
  migration_00x_*.sql      migration (idempotent, รันซ้ำได้)
scripts/
  mqtt_to_db.py            MQTT → DB (event) + เปิด mqtt_status.py (heartbeat)
  alert_watcher.py         เฝ้าระบบ, สร้าง alert, ส่ง Telegram, รายงานรายวัน
  telegram_bot.py          Telegram menu bot
  mqtt_sim.py              ตัวจำลอง CIRA CORE
  failure_test.py          ทดสอบว่าข้อมูลไม่หายเมื่อ DB / MQTT ล่ม
  dev-all.mjs              รันเว็บ + watcher + bot พร้อมกัน
DOC/                       เอกสารแผน, ความคืบหน้า, คู่มือ CIRA CORE, checklist ทดสอบ
docker-compose.yml         PostgreSQL, Mosquitto, Adminer
```

## Getting started

### Prerequisites

- Node.js 20+ และ npm
- Python 3.12+
- Docker Desktop

### 1. ติดตั้ง

```powershell
git clone https://github.com/SaranphatTreepien/cira-fruit-defect-dashboard.git
cd cira-fruit-defect-dashboard
npm install
pip install paho-mqtt psycopg2-binary
```

### 2. ตั้งค่า environment

คัดลอก `.env.example` เป็น 2 ไฟล์ แล้วแก้ค่า (ดูคำอธิบายในไฟล์):

```powershell
Copy-Item .env.example .env
Copy-Item .env.example .env.local
```

- `.env` — `DB_USER`, `DB_PASSWORD`, `DB_NAME`, Telegram, Gemini
- `.env.local` — `DATABASE_URL` และค่าของ `mqtt_to_db.py`

### 3. เปิด database และ broker

```powershell
docker compose up -d
```

### 4. สร้างตาราง (ครั้งแรก)

```powershell
foreach ($f in "schema_core.sql","migration_001_names.sql","migration_002.sql","migration_003_alerts.sql","migration_004_notify.sql","migration_005_perf.sql","migration_006_auth.sql") {
  docker cp ".\db\$f" "cira-db:/tmp/$f"
  docker exec cira-db psql -U cira -d cira_core -v ON_ERROR_STOP=1 -f "/tmp/$f"
}
```

`db/seed_defects.sql` ใส่ชนิดตำหนิตัวอย่าง (bruise / rot / crack)

### 5. รัน

ทุกอย่างใน Docker (เว็บ, writer, alert_watcher, telegram_bot รวมอยู่ใน `docker-compose.yml`):

```powershell
docker compose up -d --build   # ครั้งแรก / หลังแก้โค้ด
docker compose up -d           # ครั้งต่อไป
docker compose logs -f writer watcher
```

หรือรันบนเครื่องตอนพัฒนา (หยุด container ที่ซ้ำกันก่อน):

```powershell
docker compose stop web writer
npm run dev        # เว็บ http://localhost:3000 + alert_watcher + telegram_bot
npm run writer     # อีกหน้าต่าง: MQTT → DB
```

เปิด http://localhost:3000 แล้วเลือกบัญชี demo ในหน้า login หรือปิด demo (`DEMO_LOGIN=0`) แล้วสร้าง Admin คนแรกเอง

### 6. ไม่มี CIRA CORE? ใช้ตัวจำลอง

```powershell
npm run sim                                        # 30 ผล/นาที จนกด Ctrl+C
npm run sim -- --rate 120 --defect-pct 60
npm run sim -- --switch-model sim-v2 --switch-after 60
npm run sim -- --bad-pct 5 --dup-pct 10            # ทดสอบการปฏิเสธ payload และกันนับซ้ำ
npm run sim -- --scenario demo                     # กะจำลอง ~5 นาที: เร่งไลน์ → พีค → ล็อตเสีย → สลับโมเดล → กล้องหลุด → กลับมา
npm run sim -- --scenario demo --loop --speed 2    # วนซ้ำไม่หยุด เร็วขึ้น 2 เท่า (ไว้เปิดโชว์)
```

หน้า Live มีฉาก 2D / 3D (ปุ่ม 2D/3D, จำค่าไว้ในเบราว์เซอร์) และโหมดจอใหญ่ `/simulate?tv=1`

## npm scripts

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | เว็บ (dev) + alert_watcher + telegram_bot (`NO_WATCHER=1` / `NO_BOT=1` เพื่อข้าม) |
| `npm run build` / `npm run start` | build แล้วรันแบบ production (เร็วกว่า dev ~4 เท่า) |
| `npm run writer` | `scripts/mqtt_to_db.py` |
| `npm run sim` | ตัวจำลอง CIRA CORE |
| `npm run failure-test -- --yes` | ทดสอบ DB / MQTT ล่ม (หยุด container ชั่วคราว) |
| `npm run watcher` / `npm run bot` | รัน watcher / bot แยก |
| `npm run test:telegram` | ส่งข้อความทดสอบเข้า Telegram |
| `npm run typecheck` | ตรวจ TypeScript |

## Data contract (CIRA CORE → MQTT)

Topic `cira/fruit/events` — 1 ข้อความต่อผลไม้ 1 ผล (หรือ `{"events": [...]}`)

```json
{
  "event_id": "cira-20261105T043240-3999",
  "run": "20261105T043240",
  "track_id": 3999,
  "timestamp": "2026-11-05T04:32:44.901610+00:00",
  "fruit_type": "orange",
  "external_result": "defect",
  "defect_type": "rot",
  "nir_result": "not_supported",
  "confidence": 0.63,
  "camera_view": "top",
  "model_version": "quick-v0.1",
  "model_source": "quick"
}
```

| Field | จำเป็น | หมายเหตุ |
|---|---|---|
| `event_id` | ✔ | ไม่ซ้ำ ใช้กันข้อมูลซ้ำ |
| `timestamp` | ✔ | ISO 8601 |
| `external_result` | ✔ | `good` / `defect` |
| `run`, `track_id` | แนะนำ | ใช้กันนับผลไม้ลูกเดิมซ้ำ |
| `fruit_type`, `defect_type`, `model_version` | | ค่าที่ไม่รู้จักเก็บเป็น NULL (ค่าเดิมอยู่ใน `raw`) · `model_version` ใหม่ลงทะเบียนอัตโนมัติ |

Topic `cira/fruit/status/<device>` — heartbeat `{"device_id", "source_type", "state", "detail"}`
(`state`: `started` / `playing` / `end` · ไม่มี heartbeat เกิน 6 วิ = `offline`)

## Testing

- `npm run typecheck`
- `npm run failure-test -- --yes` — ตรวจว่า event ไม่หายเมื่อ DB หรือ MQTT ล่ม
- [DOC/failure-test-checklist.md](DOC/failure-test-checklist.md) — กรณีทดสอบด้วยมือ (writer ล่ม, CORE ปิด, เน็ตหลุด, payload เสีย, FP/FN)

## Roadmap

- [ ] ยืนยัน JSON contract กับทีม C แล้วปรับ schema
- [ ] Quick Model (CiRA ClassifTrain 4 คลาส) ระหว่างรอโมเดลทีม
- [ ] ใส่ precision / recall / mAP จากทีม B ในตาราง `models`
- [ ] Offline → online sync และ production (Supabase + Vercel) — พักไว้
- [ ] แจ้งเตือนทาง LINE

## Security notes

- ห้าม commit `.env` / `.env.local` (อยู่ใน `.gitignore`)
- บัญชี demo มีรหัสผ่านที่ทุกคนเห็นในหน้า login — ตั้ง `DEMO_LOGIN=0` เมื่อเปิดให้คนอื่นในเครือข่ายเข้าถึง
- Mosquitto DEV เปิด `allow_anonymous` และผูกกับ `127.0.0.1` เท่านั้น

## Team

| | ชื่อ | หน้าที่ |
|---|---|---|
| A | วุฒิไกร แย้มพุ่ม | Dataset / Labeling |
| B | ธาริณี สนิทสตรี | Training (CIRA CORE) |
| C | ณัฐกฤษณ์ เบ้าสาลี | Coding & Functions |
| D | ศรัณย์ภัทร ตรีเพียร | Platform & Dashboard |
