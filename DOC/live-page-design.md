# ออกแบบหน้า Live (แทน Simulate)

หน้า `/simulate` เปลี่ยนเป็นหน้า **Live** แสดงสิ่งที่ระบบกำลังทำจริง ใช้ข้อมูลจาก DB เท่านั้น
CIRA CORE สั่งจากเว็บไม่ได้ จึงตัดปุ่มควบคุมทั้งหมด

## แหล่งข้อมูล
| ส่วน | แหล่ง | poll |
|---|---|---|
| สถานะเครื่อง | VIEW `device_status_live` ผ่าน `/api/live` | 2 วิ |
| ตัวนับ / feed / ตะกร้า | `fruit_events` ผ่าน `/api/live?window=N` | 2 วิ |
| MQTT / DB / Internet | `/api/system-health` (ของเดิม) | 5 วิ |

## ส่วนของหน้า
1. **แถบสถานะเครื่อง** : playing / started / offline (+ age, เวลา event ล่าสุด)
   - offline → ภาพหยุด สีเทา ข้อความ "เครื่องหยุด"
2. **แถบ MQTT / DB / Internet** : สีตามสถานะจริง
   - ปุ่ม Internet จำลอง offline (เฉพาะ UI, เก็บ localStorage `cira-core-online` เดิม) ป้ายกำกับ "จำลอง" และแสดง banner offline
3. **ตัวนับ** ตามช่วงเวลา (5 นาที / 15 นาที / 1 ชม. / 8 ชม. / 24 ชม.)
   - good, defect, total, defect rate, events/นาที (60 วินาทีล่าสุด)
   - แยกตาม `fruit_type` จากข้อมูล ไม่ hardcode ชนิด
   - ใช้ช่วงเวลาแทน `session_id` เพราะส่วนใหญ่เป็น null
4. **Live feed + ตะกร้า** ดี / เสีย
   - feed 30 event ล่าสุด: ts, fruit_type, ผล, defect_type, confidence, track_id, camera_view, model_version
   - event ใหม่ (event_id ที่ยังไม่เคยเห็น) ทำให้ผลไม้ตกลงตะกร้าที่ตรงผล และตะกร้ากะพริบ
   - animate เฉพาะตอน state = playing / started (โหลดครั้งแรกไม่ animate ย้อนหลัง)

## ตัดออก
Start/Stop/Reset, speed, threshold, camera, notification, detection mode, mismatch, NIR/Servo/OLED, sync queue, ตัวเลขสมมติทั้งหมด

## ไม่แตะ
หน้าอื่น, Users/Login/My Team/Fruit Profiles, `scripts/mqtt_*.py`, docker-compose, mosquitto, flow CIRA

## ข้อสังเกต
- Topbar (Shell) ยังมี "Throughput 84 ผล/นาที" และ Sidebar "NIR 184 ms" แบบ hardcode อยู่นอกขอบเขตงานนี้
- ถ้าไม่มี event เลยในช่วงเวลา → แสดง 0 / "ไม่มีข้อมูล" ไม่เติมค่าปลอม
