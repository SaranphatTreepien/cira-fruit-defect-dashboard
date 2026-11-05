โปรเจกต์: C:\CiraCoreProject\fruitdefect (Next.js + Postgres ใน Docker)
อ่าน "จดสถานะล่าสุด.txt" ก่อน (สถานะระบบ, schema, สิ่งที่ทำไปแล้ว)

เป้าหมาย: ให้ Dashboard ใช้ข้อมูลจริงจาก DB แทน mock

หน้าโฟกัส (แก้ให้ใช้ข้อมูลจริง):
- Live (แทน Simulate เดิม: แสดงว่าระบบกำลังรันอะไรอยู่)
- Dashboard Log
- System Status
- Report + AI
- Alert & Reports

กติกาของหน้าโฟกัส:
- ส่วนไหนมีข้อมูลใน DB รองรับ -> ใส่ให้ครบ ดึงจริงทุกจุด
- ส่วนไหนไม่มีข้อมูลรองรับ (เช่น Sync queue, NIR/Servo/OLED, LINE/Telegram
  delivery, Internal defect ถ้า DB ไม่มี) -> ตัดออกจากหน้านั้น
  อย่า hardcode และอย่าแสดงเลขปลอม

หน้าไม่โฟกัส (Users, Login, My Team, Fruit Profiles):
- เก็บไว้ตามเดิม ห้ามลบ ห้ามแก้ ไม่ต้องต่อ DB
- ถ้า mock data ที่หน้าเหล่านี้ใช้อยู่ ให้เก็บไฟล์ mock นั้นไว้ด้วย

ข้อห้าม:
- ห้ามแก้ scripts/mqtt_*.py, docker-compose.yml, mosquitto.conf, flow CIRA
- สถานะกล้องอ่านจาก VIEW device_status_live เท่านั้น (ห้ามอ่าน device_status ตรง ๆ)
- DB: docker exec cira-db psql -U cira -d cira_core
- ห้ามใส่รหัสผ่านในไฟล์, ถามก่อนลบไฟล์ใด ๆ

วิธีทำ:
1. อ่านไฟล์สรุป + โค้ดที่เกี่ยวข้อง แล้วเสนอแผนสั้น ๆ: แต่ละหน้าโฟกัส
   จะดึงอะไรจากตาราง/คอลัมน์ไหน และตัดส่วนไหนทิ้ง พร้อมลำดับงาน
   รอฉันอนุมัติก่อนลงมือ
2. หลังอนุมัติ ทำทีละหน้า จบแต่ละหน้าบอกวิธีทดสอบสั้น ๆ แล้วหยุดรอ
3. ตอบกระชับ ไม่ต้องอธิบายยาว