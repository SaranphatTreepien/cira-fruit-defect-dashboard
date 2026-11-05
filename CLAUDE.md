# CIRA CORE Fruit Defect Sorter & Counter

## เป้าหมายโครงการ

สร้าง Dashboard สำหรับระบบคัดแยกและนับผลไม้ของ CIRA CORE ให้พัฒนาเว็บและทดสอบได้ก่อนที่ระบบ real-time และโมเดลจริงจะพร้อม โดยเริ่มจากข้อมูลจำลอง แล้วเปลี่ยนแหล่งข้อมูลเป็น CIRA CORE ภายหลังโดยไม่ต้องเปลี่ยนหน้าเว็บ

## แนวทางสถาปัตยกรรม

```
CIRA CORE (จริง / ตัวจำลอง) → Ingest JSON → PostgreSQL (DEV) → Dashboard
                                                └→ Supabase (PROD)
```

- DEV ใช้ PostgreSQL ใน Docker; PROD ใช้ Supabase และ deploy Dashboard บน Vercel
- ต้องรองรับการทำงาน offline: เก็บข้อมูลใน Dashboard ที่หน้างาน แล้ว sync ขึ้นระบบ online เมื่อกลับมาเชื่อมต่อได้
- เว็บควรอ่านข้อมูลจาก DB เท่านั้น เพื่อสลับระหว่างตัวจำลอง, Quick Model และโมเดลของทีมได้โดยไม่แก้เว็บ

## ขอบเขต Dashboard

- Simulate + Log + Control: สั่ง Start/Stop, ตั้งค่า speed/threshold/camera/notifications และจำลองการคัดแยกลงตะกร้าดีหรือเสีย
- Dashboard Log: ดู log โดยละเอียดและ export CSV
- Alert และรายงานสรุป
- Report + AI Agent สำหรับวิเคราะห์และคาดการณ์จากข้อมูล
- Login และจัดการผู้ใช้เป็นงานภายหลัง

## ลำดับงาน

1. ทำโครงหน้าเว็บและข้อมูลจำลองก่อน
2. รับ output จำลองจาก CIRA CORE และเก็บลง DB
3. ออกแบบ schema จาก output จริง แล้วปรับเว็บ/DB ให้ใช้ schema นั้น
4. Sync CIRA CORE กับเว็บ และทำหน้า Simulate
5. ตั้งค่า production (Supabase + Vercel) เมื่อทีม A, B และ C พร้อม

ห้ามสร้าง schema หรือ table จนกว่าจะยืนยันรูปแบบข้อมูลที่ CIRA CORE ส่งจริง

## สถานะปัจจุบัน

- PostgreSQL 16 DEV container พร้อมแล้ว: `cira-db` บน `127.0.0.1:5432`; health check และ `select 1` ผ่าน
- เว็บยังไม่ได้เชื่อมต่อฐานข้อมูล
- ยังไม่มี schema/table

## ข้อตกลงข้อมูลกลาง

ทุกแหล่งข้อมูลควรส่ง event หน้าตาเดียวกันก่อนเข้า DB โดยอย่างน้อยมี:

- `event_id` ที่ไม่ซ้ำ เพื่อกันข้อมูลซ้ำในการ sync
- `timestamp`, `fruit_type`, `external_result`, `defect_type`, `nir_result`
- `confidence`, `camera_view`, `model_version`, `model_source`

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

- ใช้ `event_id` และสถานะ sync เพื่อกันข้อมูลซ้ำระหว่าง offline → online
- ใช้ schema เดียวกันสำหรับ PostgreSQL DEV, offline และ Supabase PROD
- เก็บ LINE/Telegram API keys ใน environment variables ห้ามฝังในโค้ด
- ทดสอบทั้ง false positive/false negative, hardware failure และ network failure
