# ความคืบหน้า Platform & Test (บทบาท D) — อัปเดต 2026-10-04

**ต่อเนื่องจาก:** `Saranphat_Platform_Plan.md`
**ผู้รับผิดชอบ:** Saranphat
**ไฟล์ flow ทดสอบของ CIRA CORE:** `testSentMQTTandPosgrestoDOCKER.npj`
(สร้างไว้สำหรับทดสอบส่งข้อมูลทั้งทาง MQTT และทาง Python ตรงเข้า PostgreSQL ใน Docker; ควรเก็บไว้ในโฟลเดอร์ `flows\` ของโปรเจกต์)

---

## 1. สรุปสั้น

- **ขั้นที่ 2 (DB ใน Docker): เสร็จ** DB พร้อมใช้ และสร้างตารางเริ่มต้นแล้ว
- **ขั้นที่ 3 (ทดสอบ Mock จาก CIRA CORE): เสร็จ** CORE ส่งค่าออกมาได้ 2 ทาง และเก็บลง DB สำเร็จทั้งสองทาง
  - ทาง A: กล่อง `Python` ใน CORE → INSERT เข้า PostgreSQL ตรง ๆ (`psycopg2`)
  - ทาง B: กล่อง `Python` สร้าง payload → `MqttPub` → Mosquitto → `scripts\mqtt_to_db.py` → PostgreSQL
- ทาง B คือทางหลักที่จะใช้ต่อ (CORE ไม่ต้องรู้จัก DB ตรง ๆ) ทาง A เก็บไว้เป็นทางสำรอง
- **ยังไม่ได้ทำ:** เชื่อมเว็บกับ DB, ทดสอบกรณี DB/ตัวรับล่ม, โมเดลสำรอง, Adminer

---

## 2. สถานะเทียบกับ Checklist ในแผนเดิม

### ขั้นที่ 2: DB ใน Docker
- [x] ทำ container DB (Docker): PostgreSQL 16 (`cira-db`)
- [ ] ต่อเว็บกับ DB: **ตั้งใจเลื่อนไว้** (ลองสร้าง route ใน Next.js ไปแล้วแต่ยังไม่ได้ทดสอบ และตัดสินใจกลับมาทำฝั่ง CORE → DB ก่อน)
- [x] ~~ยังไม่ต้องออกแบบ schema~~ **ปรับจากแผน:** สร้าง schema เริ่มต้น (7 ตาราง) ไปก่อน เพราะต้องมีตารางรับข้อมูลทดสอบ ปรับทีหลังได้ด้วย migration

### ขั้นที่ 3: ทดสอบ Mock จาก CIRA CORE
- [x] ให้ CIRA CORE mock ค่าออกมาด้านนอก
- [x] ทดสอบว่ารับค่าที่ mock ได้
- [x] เก็บลง DB ได้
- [ ] โมเดลสำรอง (Quick Model) ตามหัวข้อ 9: ยังไม่ได้เริ่ม

### ขั้นที่ 4: ออกแบบ DB Schema
- [ ] ยังเป็นร่างแรก รอดูผลจากโมเดลจริง/JSON ของ C ก่อนปรับ

---

## 3. สภาพแวดล้อมที่ใช้

| รายการ | ค่า |
|---|---|
| Root โปรเจกต์ | `C:\CiraCoreProject\fruitdefect` |
| PostgreSQL | `postgres:16`, container `cira-db`, `127.0.0.1:5432` |
| DB / User | `cira_core` / `cira` (รหัสผ่านอยู่ใน `.env.local` และ `docker-compose.yml` ห้าม commit) |
| MQTT broker | `eclipse-mosquitto:2`, container `cira-mqtt`, `127.0.0.1:1883` (dev: `allow_anonymous true`) |
| **MQTT topic** | **`cira/fruit/events`** (QoS 1 ฝั่งตัวรับ) |
| Python ของเครื่อง (ตัวรับ/สคริปต์ทดสอบ) | 3.14.0 + `psycopg2` 2.9.11 + `paho-mqtt` |
| Python ที่กล่อง Python ของ CORE ใช้ | **Python312** (`C:\Users\Saranphat\AppData\Local\Programs\Python\Python312\python.exe`, 3.12.10) |
| Library ที่ติดตั้งเพิ่มให้ Python312 | `numpy`, `opencv-python`, `psycopg2-binary` (กล่อง Python ของ CORE ต้องใช้ `numpy` และ `cv2` ในโค้ดครอบ) |

---

## 4. ไฟล์ที่สร้างในโปรเจกต์

| ไฟล์ | หน้าที่ | สถานะ |
|---|---|---|
| `db\schema_core.sql` | สร้าง 7 ตาราง + ข้อมูลตั้งต้น (apple/orange, mock/quick-v0.1) | ใช้งานแล้ว |
| `db\migration_001_names.sql` | เพิ่มคอลัมน์ `name_en`, `name_zh` ใน `fruit_types`/`defect_types` | ใช้งานแล้ว |
| `mosquitto\mosquitto.conf` | config ของ broker (listener 1883, persistence) | ใช้งานแล้ว |
| `docker-compose.yml` | เพิ่ม service `mosquitto` | ใช้งานแล้ว |
| `scripts\test_insert.py` | ทดสอบ INSERT จาก Python นอก CORE | ใช้งานแล้ว |
| `scripts\mqtt_to_db.py` | ตัวรับ: subscribe `cira/fruit/events` → INSERT เข้า `fruit_events` | ใช้งานแล้ว |
| `testSentMQTTandPosgrestoDOCKER.npj` | flow ของ CORE ที่ใช้ทดสอบ (ดูหัวข้อ 6) | ใช้งานแล้ว |
| `app\api\ingest\route.ts`, `src\db\pool.ts`, `scripts\mock-send.ps1` | route ใน Next.js สำหรับรับ JSON | **สร้างแล้วแต่ยังไม่ได้ทดสอบ / ยังไม่ใช้** |

### ตารางใน DB (`schema_core.sql`)
`fruit_types`, `defect_types`, `models`, `run_sessions`, `fruit_events`, `system_logs`, `settings`
(ตารางหลักคือ `fruit_events`: 1 แถว = ผลไม้ 1 ผล; คอลัมน์ `raw` เป็น JSONB เก็บ JSON ดิบ; `event_id` เป็น primary key กันซ้ำ)

---

## 5. คำสั่งที่ใช้ (PowerShell, รันจาก `C:\CiraCoreProject\fruitdefect`)

### 5.1 DB / Docker

```powershell
# เริ่ม DB และ broker
docker compose up -d db
docker compose up -d mosquitto

# ดูสถานะ container
docker ps

# หา user/db ของ DB
docker exec cira-db env | findstr POSTGRES

# สร้างตาราง (copy ไฟล์เข้า container แล้วรัน)
docker cp .\db\schema_core.sql cira-db:/tmp/schema_core.sql
docker exec cira-db psql -U cira -d cira_core -f /tmp/schema_core.sql

# เพิ่มชื่อ EN/ZH
docker cp .\db\migration_001_names.sql cira-db:/tmp/migration_001_names.sql
docker exec cira-db psql -U cira -d cira_core -f /tmp/migration_001_names.sql

# ดูตาราง
docker exec cira-db psql -U cira -d cira_core -c "\dt"

# ล้างทั้ง schema (ใช้ตอนยังไม่มีข้อมูลจริงเท่านั้น)
docker exec cira-db psql -U cira -d cira_core -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
```

### 5.2 ดูข้อมูลใน DB

```powershell
# 5 แถวล่าสุด
docker exec cira-db psql -U cira -d cira_core -c "SELECT event_id, fruit_type, external_result, confidence, model_source FROM fruit_events ORDER BY created_at DESC LIMIT 5;"

# ดูทุกคอลัมน์แบบแนวตั้ง
docker exec cira-db psql -U cira -d cira_core -x -c "SELECT * FROM fruit_events ORDER BY created_at DESC LIMIT 1;"

# สรุปยอดตามชนิด/ผล
docker exec cira-db psql -U cira -d cira_core -c "SELECT fruit_type, external_result, count(*) FROM fruit_events GROUP BY 1,2 ORDER BY 1,2;"

# ดึงฟิลด์จาก JSON ดิบ
docker exec cira-db psql -U cira -d cira_core -c "SELECT event_id, raw->>'confidence' AS conf FROM fruit_events ORDER BY created_at DESC LIMIT 3;"

# ล้างแถวทดสอบ
docker exec cira-db psql -U cira -d cira_core -c "DELETE FROM fruit_events WHERE model_source = 'mock';"
```

### 5.3 MQTT

```powershell
# ดู log ของ broker
docker logs --tail 20 cira-mqtt

# ยิงข้อความทดสอบเข้า broker โดยตรง (ไม่ผ่าน CORE)
docker exec cira-mqtt mosquitto_pub -t cira/fruit/events -m '{\"event_id\":\"mqtt-test-1\",\"timestamp\":\"2026-10-04T11:00:00+00:00\",\"fruit_type\":\"apple\",\"external_result\":\"good\",\"confidence\":0.93,\"camera_view\":\"top\",\"model_version\":\"mock\",\"model_source\":\"mock\"}'

# รันตัวรับ (ค้างไว้ในหน้าต่างหนึ่ง เป็นหน้าต่าง "tail" ของข้อความที่เข้า)
pip install paho-mqtt
$env:DATABASE_URL = "postgresql://cira:<รหัสผ่าน>@127.0.0.1:5432/cira_core"
python .\scripts\mqtt_to_db.py
```

### 5.4 ติดตั้ง library ให้ Python312 ของ CORE

```powershell
py -0p   # ดูว่ามี Python เวอร์ชันไหนบ้าง

$py312 = "C:\Users\Saranphat\AppData\Local\Programs\Python\Python312\python.exe"
& $py312 -m pip install numpy opencv-python psycopg2-binary
& $py312 -c "import numpy, cv2, psycopg2; print('OK')"
```

### 5.5 ทดสอบ Python → DB นอก CORE

```powershell
$env:DATABASE_URL = "postgresql://cira:<รหัสผ่าน>@127.0.0.1:5432/cira_core"
python .\scripts\test_insert.py
```

---

## 6. วิธีทดสอบใน CIRA CORE (ไฟล์ `testSentMQTTandPosgrestoDOCKER.npj`)

ใน flow มี 2 ชุดแยกกัน กดทดสอบทีละชุดได้

### ชุด A: Python ส่งเข้า DB ตรง

```
Button Run → Python (Python312) → Debug
```

| กล่อง | การตั้งค่า |
|---|---|
| Button Run | ตัวทริกเกอร์ (กด 1 ครั้ง = 1 เหตุการณ์) |
| Python | เลือก **Python312**; โค้ด `psycopg2` เชื่อม `127.0.0.1:5432` แล้ว INSERT 1 แถวเข้า `fruit_events` |
| Debug | ดูสิ่งที่ไหลผ่านสาย (แท็บ Payload) |

ผลที่กล่อง Python พิมพ์ออกมา: `INSERT OK <event_id>` (event_id มีคำว่า `-core-`)

### ชุด B: Python สร้าง payload → MqttPub → broker → DB

```
Button Run → Python (Python312) → Mqtt Pub
```

| กล่อง | การตั้งค่า |
|---|---|
| Button Run | ตัวทริกเกอร์ |
| Python | เลือก **Python312**; สร้าง JSON ตามรูปแบบกลางแล้วใส่ในตัวแปร `payload` (ดูโค้ดด้านล่าง) |
| Mqtt Pub | host `127.0.0.1`, port `1883`, topic **`cira/fruit/events`** |

โค้ดในกล่อง Python ของชุด B:

```python
import datetime, uuid, random

now = datetime.datetime.now(datetime.timezone.utc)
ev = {
    "event_id": now.strftime("%Y%m%dT%H%M%S%f") + "-mqtt-" + uuid.uuid4().hex[:6],
    "timestamp": now.isoformat(),
    "fruit_type": random.choice(["apple", "orange"]),
    "external_result": random.choice(["good", "defect"]),
    "defect_type": None,
    "nir_result": "not_supported",
    "confidence": round(random.uniform(0.70, 0.99), 2),
    "camera_view": "top",
    "model_version": "mock",
    "model_source": "mock",
}

payload.clear()
payload.update(ev)
print("payload set:", payload["event_id"])
```

**หมายเหตุ:** ตัวแปรที่กล่อง Python ของ CORE เตรียมไว้ให้คือ `json`, `sys`, `numpy`, `cv2`, `payload`, `img`, `isHaveNewImg` — ใช้ `payload` เป็นตัวส่งข้อมูลออกตามสาย

### ขั้นตอนทดสอบชุด B ทั้งหมด

1. `docker ps` ต้องเห็น `cira-db` และ `cira-mqtt` สถานะ Up
2. รันตัวรับ `python .\scripts\mqtt_to_db.py` ค้างไว้ ต้องเห็น `connected Success`
3. เปิด flow `testSentMQTTandPosgrestoDOCKER.npj` ใน CORE แล้วกด **Run** ที่ Button Run ของชุด B
4. หน้าต่างตัวรับควรขึ้น `inserted <event_id>`
5. ตรวจใน DB ด้วยคำสั่ง `SELECT ... LIMIT 5` (หัวข้อ 5.2)

---

## 7. ผลการทดสอบ

| # | ทดสอบ | ผล | หลักฐาน |
|---|---|---|---|
| 1 | สร้างตาราง 7 ตารางจาก `schema_core.sql` | ผ่าน | `\dt` เห็นครบ 7 ตาราง, `INSERT 0 2` สองครั้ง |
| 2 | เพิ่มคอลัมน์ชื่อ EN/ZH (`migration_001`) | ผ่าน | `SELECT code, name_th, name_en, name_zh` เห็นค่าครบ |
| 3 | INSERT มือ + constraint (FK ชนิดผลไม้) | ผ่าน | แถว `test-0001` เข้าตาราง |
| 4 | Python 3.14 ของเครื่อง → DB (`test_insert.py`) | ผ่าน | แถว `...-py` (ครั้งแรกรหัสผ่านผิดเพราะใส่ `PASSWORD` ตามตัวอย่าง) |
| 5 | **CORE ชุด A**: กล่อง Python (Python312) → DB ตรง | **ผ่าน** | `INSERT OK ...-core-dda9fc` และมีแถวใน DB |
| 6 | `mosquitto_pub` → ตัวรับ → DB (ไม่ผ่าน CORE) | ผ่าน | แถว `mqtt-test-1` |
| 7 | **CORE ชุด B** ต่อ `Button Run → MqttPub` ตรง (payload ว่าง) | ได้ผลตามคาด (ไม่ผ่าน) | ตัวรับขึ้น `FAIL 'event_id' b'{}'` แปลว่าส่งถึง broker แล้ว แต่ข้อความเป็น `{}` ไม่มีแถวขยะเข้า DB |
| 8 | **CORE ชุด B** `Button Run → Python → MqttPub` | **ผ่าน** | ตัวรับขึ้น `inserted ...-mqtt-94440f` และมีแถวใน DB |

### ข้อมูลใน `fruit_events` หลังทดสอบ (ผลจาก `SELECT`)

| event_id | แหล่งที่มา | fruit_type | external_result | model_source |
|---|---|---|---|---|
| `20261004T035046227931-mqtt-94440f` | CORE → MqttPub (ชุด B) | apple | good | mock |
| `mqtt-test-1` | `mosquitto_pub` ด้วยมือ | apple | good | mock |
| `20261004T034217014183-core-dda9fc` | CORE → Python ตรง (ชุด A) | orange | good | mock |
| `20261004T033759898332-py` | `test_insert.py` | apple | defect | mock |
| `test-0001` | INSERT มือ | apple | defect | mock |

**สรุปผล:** เส้นทาง CORE → Postgres ใช้งานได้จริงทั้ง 2 ทาง; เส้นทาง MQTT ทำงานครบสาย (CORE → MqttPub → Mosquitto → ตัวรับ → PostgreSQL)

---

## 8. สิ่งที่ค้นพบระหว่างทำ (บันทึกไว้กันพลาด)

- **PowerShell:** `<` redirect แบบ Linux ใช้ไม่ได้ ใช้ `docker cp` แล้วรันด้วย `psql -f` แทน; การวาง here-string (`@' ... '@`) พลาดง่าย จนไฟล์ว่าง ควรเช็กขนาดไฟล์ด้วย `(Get-Item ไฟล์).Length` ทุกครั้งหลังสร้าง
- **คำสั่งตัวอย่างต้องแทนค่าจริง:** เคยรันด้วย `-U USER -d DB` และ `PASSWORD` ตามตัวอย่างโดยไม่แทนที่ → ใช้ `cira` / `cira_core` / รหัสผ่านจริง
- **กล่อง Python ของ CORE** ใช้ Python คนละตัวกับ Python ของเครื่อง ต้องติดตั้ง library ให้ **Python312** แยกต่างหาก และโค้ดครอบของกล่องต้องการ `numpy` กับ `cv2`
- **MqttPub** ส่งเฉพาะเนื้อ `payload` เป็น JSON (ตัวรับอ่าน `event_id` ที่ระดับบนสุดได้) ถ้า payload ว่างจะส่ง `{}`
- **Debug box** ของ CORE แสดงข้อมูลห่อในซองที่มี `payload` และ `timestamp` ของ CORE เอง (timestamp นี้ไม่ใช่ `ts` ในตารางของเรา)
- **เวลา:** `ts` เก็บเป็น UTC (`TIMESTAMPTZ`) ถ้าจะดูเป็นเวลาไทยใช้ `ts AT TIME ZONE 'Asia/Bangkok'`
- **log ของ CORE:** คู่มือไม่ได้ระบุว่า CORE เขียน log ไฟล์ที่ไหน ที่ใช้ดูได้คือกล่อง Debug, แถบผลลัพธ์ในหน้าต่าง Python และหน้าต่างตัวรับ `mqtt_to_db.py`; ฝั่ง DB ใช้ `docker logs -f --tail 20 cira-db`

---

## 9. ข้อจำกัด / ความเสี่ยงที่ยังเหลือ

- **ตัวรับ `mqtt_to_db.py` ยังไม่ทนต่อการล่ม:** ถ้าตัวรับไม่ได้รันตอน CORE ส่ง ข้อความน่าจะหาย (ยังไม่ได้ทดสอบ แต่ paho เชื่อมแบบไม่เก็บ session) ต้องแก้ก่อนใช้จริง และเป็นส่วนของการทดสอบ Network (หัวข้อ 6 ของแผน)
- **ตอนนี้ข้อมูลเป็นค่าสุ่ม (mock)** ยังไม่ได้มาจากโมเดล `DeepClassif`/`DeepDetect` จริง
- **Broker เปิด `allow_anonymous true`** ใช้ได้เฉพาะ dev (ผูกกับ 127.0.0.1) ก่อนขึ้น prod ต้องตั้ง user/password
- **รหัสผ่านของ DB เป็นค่า dev** (`.env.local`, `docker-compose.yml`) ต้องเปลี่ยนก่อนขึ้น prod และไม่ควรฝังรหัสผ่านในโค้ดที่กล่อง Python ของ CORE (ตอนนี้ชุด A ฝังอยู่ ชุด B ไม่ต้องใช้รหัสผ่านใน CORE)
- รูปแบบ JSON ยังเป็น**ร่างของเรา** ยังไม่ได้ยืนยันกับ C (ณัฐกฤษณ์)

---

## 10. สิ่งที่จะทำต่อ (เรียงตามที่เสนอ)

1. **ทดสอบกรณีพัง (Network):** ปิดตัวรับ/ปิด DB ระหว่างกด Run แล้วดูว่าข้อมูลหายไหม จากนั้นแก้ตัวรับให้เก็บข้อความไว้ที่ broker ระหว่างล่ม (client id ตายตัว, `clean_start=False`, ยืนยันข้อความหลัง INSERT สำเร็จ)
2. **Start/Stop + `run_sessions`:** ให้การสั่งเริ่ม/หยุดสร้างแถวใน `run_sessions` แล้วผูก `session_id` กับทุก event (รากฐานของขั้นที่ 5)
3. **โมเดลสำรอง (หัวข้อ 9 ของแผน):** ต่อ `DeepClassif` แทนค่าสุ่ม แล้วเขียน adapter แปลงผลเป็นรูปแบบกลาง
4. **ส่งรูปแบบ JSON กลางให้ C/A/B** ยืนยันก่อนออกแบบ schema ขั้นที่ 4
5. **เพิ่ม Adminer** ใน `docker-compose.yml` เพื่อดูตารางผ่านเบราว์เซอร์ (`localhost:8080`)
6. **ต่อเว็บกับ DB** (`GET /api/events`) หลังฝั่ง CORE → DB นิ่งแล้ว
7. อัปเดต `Project Paths` ให้ตรงสถานะจริง (บรรทัดที่เขียนว่ายังไม่สร้าง schema/table ล้าสมัยแล้ว)



 1. Flow ในหน้า CIRA CORE
[Button Run] ──► [Python (Python312)] ──► [MqttPub]
  กดปุ่ม           สร้าง event 1 ผล         ส่งเข้า broker
                   ใส่ใน payload            127.0.0.1:1883
                                            topic cira/fruit/events

ตอนนี้กล่อง Python สร้างค่าสุ่ม ภายหลังจะเปลี่ยนเป็น

[WebCam] ──► [DeepClassif] ──► [Python (adapter)] ──► [MqttPub]
 ภาพจากกล้อง   ผลจากโมเดล       แปลงเป็น JSON กลาง       ส่งเข้า broker
                                 + สร้าง event_id
2. ทางเดินข้อมูลทั้งระบบ (ทางปกติ)
CORE (MqttPub)
   │  JSON 1 ข้อความ = ผลไม้ 1 ผล
   ▼
Mosquitto (Docker: cira-mqtt)
   │  ถือข้อความไว้จนกว่าตัวรับจะยืนยัน
   ▼
mqtt_to_db.py (ตัวรับ / writer)
   │  INSERT ... ON CONFLICT (event_id) DO NOTHING
   │  แล้วค่อยยืนยันข้อความกลับให้ broker
   ▼
PostgreSQL local (Docker: cira-db)   ◄── ต้นฉบับ
   │  แถวเข้ามาด้วย synced=false
   │
   ├──► Dashboard offline (Docker)  อ่านจาก local
   │
   ▼
ตัวซิงก์ (โปรเซสแยก วนทุกไม่กี่วินาที)
   │  ดึง synced=false เรียงตามเวลา
   │  ส่ง ON CONFLICT DO NOTHING
   ▼
Supabase                              ◄── สำเนา
   │  ตอบรับสำเร็จ
   ▼
ตัวซิงก์ UPDATE synced=true
   │
   ▼
Dashboard online (Vercel) อ่านจาก Supabase
3. ตอนเน็ตล่ม
CORE → MqttPub → Mosquitto → ตัวรับ → PostgreSQL local   ✅ ทำงานต่อปกติ
                                           │
                                           ├──► Dashboard offline  ✅ เห็นข้อมูลครบ
                                           │
                                           ▼
                                      ตัวซิงก์ ──✗──► Supabase   (ส่งไม่ผ่าน)
                                           │
                                           ▼
                                  แถวค้าง synced=false (สะสมไว้)

เน็ตกลับมา:
   ตัวซิงก์ส่งที่ค้างเรียงตามเวลา → Supabase ยืนยัน → synced=true
   Dashboard online ตามทัน
สถานะเทียบกับที่ทำแล้ว
✅ ทำแล้ว (ตามเอกสารของคุณ)        ⬜ ยังไม่ได้ทำ
────────────────────────────        ────────────────────────────
CORE → Python → MqttPub             ตัวรับแบบทนล่ม (clean_start=False,
Mosquitto                             ยืนยันหลัง INSERT)
mqtt_to_db.py → PostgreSQL          คอลัมน์ synced ในตาราง
                                    ตัวซิงก์ → Supabase
                                    Dashboard online / offline


                                  

ทีนี้อาจจะต้องเพิ่ม การ ทำ batch จาก Mqtt -> local DB 
และ Local DB -> Supabase