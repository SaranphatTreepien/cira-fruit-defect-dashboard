# CIRA CORE Fruit Defect Sorter & Counter

## เป้าหมายโครงการ

สร้าง Dashboard สำหรับระบบคัดแยกและนับผลไม้ของ CIRA CORE ให้พัฒนาเว็บและทดสอบได้ก่อนที่ระบบ real-time และโมเดลจริงจะพร้อม โดยเริ่มจากข้อมูลจำลอง แล้วเปลี่ยนแหล่งข้อมูลเป็น CIRA CORE ภายหลังโดยไม่ต้องเปลี่ยนหน้าเว็บ

## แนวทางสถาปัตยกรรม

```
CIRA CORE (จริง) / scripts/mqtt_sim.py ─MQTT cira/fruit/events + cira/fruit/status/<device>─▶ Mosquitto (cira-mqtt)
   ─▶ scripts/mqtt_to_db.py (+ mqtt_status.py) ─▶ PostgreSQL (cira-db) ─▶ Dashboard (Next.js)
                                                         ▲
                     scripts/alert_watcher.py (alert, Telegram, รายงานรายวัน) · scripts/telegram_bot.py
```

- DEV ใช้ PostgreSQL ใน Docker; PROD (Supabase + Vercel) และ offline → online sync **พักไว้ก่อน** (ตัดสินใจ 2026-11-19)
- เว็บอ่านข้อมูลจาก DB เท่านั้น เพื่อสลับระหว่างตัวจำลอง, Quick Model และโมเดลของทีมได้โดยไม่แก้เว็บ

## ข้อจำกัดของ CIRA CORE (ยืนยันจากการทดสอบ)

- CIRA CORE เป็น node-based: Start/Stop, เปลี่ยนโมเดล, threshold, ความเร็ว, กล้อง **ต้องทำใน CIRA CORE เอง** เว็บสั่งไม่ได้
- เว็บทำได้แค่ **รับค่าและดักสถานะ**: event ผลไม้ + heartbeat สถานะเครื่อง ผ่าน MQTT
- เขียนโค้ดอิสระได้เฉพาะในกล่อง `Python` ของ flow (ใช้สร้าง payload) · field ที่ CORE สร้างไม่ได้ให้ adapter ฝั่งเรา (`mqtt_to_db.py`) เติม
- อย่าสร้างหน้า/ปุ่มที่ทำเหมือนควบคุมหรือตั้งค่า CORE ได้

## ขอบเขต Dashboard

- Live: สถานะเครื่องและผลคัดแยก real-time (อ่านอย่างเดียว ไม่มี Start/Stop)
- Dashboard Log: ดู log โดยละเอียดและ export CSV
- Runs & Models: รอบการทำงานตัดอัตโนมัติจาก `device_state_log` + เทียบสถิติแยก `model_version`
- Alert & Reports: alert, กฎแจ้งเตือน, รายงานรายวัน (Telegram อัตโนมัติ), AI สรุป (Gemini)
- System Status: สุขภาพระบบ + คุณภาพข้อมูล (payload ถูกปฏิเสธ, ผลไม้ส่งซ้ำ, ค่าที่ไม่รู้จัก)
- Fruit Profiles: ข้อมูลอ้างอิงอ่านอย่างเดียว (fruit_types / defect_types / models)
- Login + Users: role `admin` / `viewer`

## ลำดับงาน

1. ทำโครงหน้าเว็บและข้อมูลจำลองก่อน
2. รับ output จำลองจาก CIRA CORE และเก็บลง DB
3. ออกแบบ schema จาก output จริง แล้วปรับเว็บ/DB ให้ใช้ schema นั้น
4. Sync CIRA CORE กับเว็บ และทำหน้า Simulate
5. ตั้งค่า production (Supabase + Vercel) เมื่อทีม A, B และ C พร้อม

Schema ปัจจุบันเป็นร่างจาก output ทดสอบของ CORE (`db/schema_core.sql` + `db/migration_00x`) · เปลี่ยนด้วย migration ใหม่ (idempotent) เท่านั้น และปรับอีกครั้งเมื่อยืนยัน JSON contract กับทีม C

## สถานะปัจจุบัน (2026-11-19)

- Docker: `cira-db` (PostgreSQL 16, host port **`127.0.0.1:15432`** → 5432 ใน container), `cira-mqtt` (`1883`), `cira-adminer` (`8080`)
- รัน: `npm run dev` = เว็บ + alert_watcher + telegram_bot · `python scripts/mqtt_to_db.py` รันแยก (เปิด mqtt_status.py ให้เอง)
- ไม่มี CORE: `python scripts/mqtt_sim.py` (ดู `--help`: rate, defect, สลับโมเดล, payload เสีย, ส่งซ้ำ)
- Migration ล่าสุด `db/migration_006_auth.sql` (users, user_sessions, alerts.acked_by_user, กฎ model_change / daily_report)
- Login: ทุก API ต้อง login (`requireUser` ใน `src/lib/auth.ts`) · ครั้งแรกที่ยังไม่มีผู้ใช้ หน้า `/login` ให้สร้าง Admin คนแรก
- ทดสอบความทนทาน: `python scripts/failure_test.py --yes` + `DOC/failure-test-checklist.md`
- ยังไม่ทำ: Quick Model, ยืนยัน JSON contract กับทีม C, sync/PROD (พักไว้), LINE
- การรันคำสั่ง psql ใน container จาก Git Bash ต้องตั้ง `MSYS_NO_PATHCONV=1` (ไม่งั้น `/tmp/...` ถูกแปลงเป็น path Windows)

## ข้อตกลงข้อมูลกลาง

ทุกแหล่งข้อมูลควรส่ง event หน้าตาเดียวกันก่อนเข้า DB โดยอย่างน้อยมี:

- `event_id` ที่ไม่ซ้ำ เพื่อกันข้อมูลซ้ำ
- `timestamp`, `fruit_type`, `external_result`, `defect_type`, `nir_result`
- `confidence`, `camera_view`, `model_version`, `model_source`
- `run` + `track_id` (CORE ส่งอยู่แล้ว): writer ใช้กันนับผลไม้ลูกเดิมซ้ำ (`DEDUP_TRACK_SEC`, ค่าเริ่ม 30)

ถ้า `model_version` ใหม่ยังไม่อยู่ในตาราง `models` writer ลงทะเบียนให้อัตโนมัติ · fruit/defect ที่ไม่รู้จักเก็บเป็น NULL (ค่าเดิมอยู่ใน `raw`) และแสดงในหน้า System Status

ค่าที่รองรับในช่วงแรก: ผลไม้ `apple`/`orange`; ผลภายนอก `good`/`defect`; NIR ใช้ค่าจำลองได้

ให้สร้าง adapter สำหรับแปลง output ของแต่ละโมเดลมาเป็นรูปแบบนี้ แทนการผูกเว็บเข้ากับโมเดลโดยตรง

## โมเดลสำรอง (Quick Model)

- ใช้เมื่อโมเดลทีมยังไม่พร้อม และ timebox งานไว้ประมาณครึ่งวันถึงหนึ่งวัน
- เทรน CiRA ClassifTrain บน Colab ด้วย 4 คลาส: `apple_good`, `apple_defect`, `orange_good`, `orange_defect`
- ใช้ภาพ 300–500 ภาพต่อคลาสโดยประมาณ, export checkpoint ที่ accuracy ดีสุด และทดสอบภาพนิ่งก่อนกล้องสด
- Quick Model จำแนกทีละภาพและไม่มี tracking; ต้องส่งหนึ่ง event ต่อผลไม้ ไม่ใช่ทุกเฟรม เพื่อไม่ให้นับซ้ำ
- เก็บภาพหน้างาน 50–100 ภาพเพื่อทดสอบ; ตรวจ license ของ dataset ก่อนใช้

## การประสานงาน

- ทีม B (Training): ขอ precision, recall, mAP และ threshold ที่แนะนำ
- ทีม C (Real-time): ต้องตกลง JSON contract ก่อนเป็นลำดับแรก
- ทีม A (Data): ใช้เป็นข้อมูลอ้างอิง/ชุดทดสอบได้

## ข้อควรระวัง

- ใช้ `event_id` (และ `synced` เมื่อกลับมาทำ sync) เพื่อกันข้อมูลซ้ำ
- ใช้ schema เดียวกันสำหรับ PostgreSQL DEV และ PROD ในอนาคต
- เก็บ LINE/Telegram API keys ใน environment variables ห้ามฝังในโค้ด
- ทดสอบทั้ง false positive/false negative, hardware failure และ network failure
