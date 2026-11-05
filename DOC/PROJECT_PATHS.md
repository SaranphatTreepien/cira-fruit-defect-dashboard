# Project Paths

เอกสารนี้ใช้รวบรวม path สำคัญของโปรเจกต์ **Fruit Defect Sorter & Counter (CIRA CORE)**  
ตำแหน่ง root ของโปรเจกต์:

```text
C:\CiraCoreProject\fruitdefect
```

## โครงสร้างหลัก

| Path | หน้าที่ |
|---|---|
| `app\` | หน้าเว็บและไฟล์ระดับแอปของ Next.js |
| `app\[[...slug]]\page.tsx` | หน้า Dashboard หลักและ route แบบ catch-all |
| `app\layout.tsx` | Root layout ของเว็บ |
| `app\globals.css` | Global CSS ของแอป |
| `src\` | โค้ดที่นำกลับมาใช้ร่วมกัน |
| `src\components\` | React components ที่ใช้ร่วมกัน |
| `src\components\ui.tsx` | UI components |
| `src\data\` | ข้อมูลจำลองและ profile ของผลไม้ |
| `src\data\mockData.ts` | ชุดข้อมูลจำลอง |
| `src\data\fruitProfiles.ts` | Profile และค่าที่เกี่ยวข้องกับผลไม้ |
| `src\hooks\` | React hooks |
| `src\hooks\useSimulation.ts` | Logic สำหรับการจำลองการทำงาน |
| `src\lib\` | Types และ helper สำหรับ data/API |
| `src\lib\types.ts` | TypeScript types กลาง |
| `src\lib\mockApi.ts` | API จำลองสำหรับ Dashboard |

## Static files และรูปภาพ

| Path | หน้าที่ |
|---|---|
| `public\` | ไฟล์ static ที่เข้าถึงได้จาก root URL |
| `public\images\` | รูปภาพที่ใช้ในเว็บ |
| `public\images\cira-core-logo.png` | Logo ของ CIRA CORE |
| `public\images\team-data.jpg` | รูปทีม Data |
| `public\images\team-platform.jpg` | รูปทีม Platform |
| `public\images\team-realtime.jpg` | รูปทีม Real-time |
| `public\images\team-training.jpg` | รูปทีม Training |
| `public\manus-routes.json` | Route configuration ที่เกี่ยวข้องกับ Manus |
| `logo.jpg` | Logo/image ที่อยู่ใน root ของโปรเจกต์ |

## Configuration และการรันระบบ

| Path | หน้าที่ |
|---|---|
| `package.json` | Dependencies และคำสั่ง `dev`, `build`, `start`, `typecheck` |
| `docker-compose.yml` | ตั้งค่า PostgreSQL 16 สำหรับ DEV |
| `.env.local` | Environment variables ในเครื่อง ห้าม commit secret |
| `tsconfig.json` | การตั้งค่า TypeScript |
| `next.config.*` | การตั้งค่า Next.js ถ้ามีการเพิ่มไฟล์ในอนาคต |
| `postcss.config.*` | การตั้งค่า PostCSS ถ้ามีการเพิ่มไฟล์ในอนาคต |
| `tailwind.config.*` | การตั้งค่า Tailwind ถ้ามีการเพิ่มไฟล์ในอนาคต |

## Database DEV

| รายการ | ค่า |
|---|---|
| Compose service | `db` |
| Container | `cira-db` |
| Database | PostgreSQL 16 |
| Host | `127.0.0.1` |
| Port | `5432` |
| Data volume | `cira_pgdata` |
| Compose file | `C:\CiraCoreProject\fruitdefect\docker-compose.yml` |

> ยังไม่สร้าง schema/table จนกว่าจะยืนยันรูปแบบ JSON ที่ CIRA CORE ส่งจริง

## คำสั่งที่ใช้บ่อย

รันเว็บในโหมด development:

```powershell
Set-Location C:\CiraCoreProject\fruitdefect
npm run dev
```

ตรวจ TypeScript:

```powershell
Set-Location C:\CiraCoreProject\fruitdefect
npm run typecheck
```

สร้าง production build:

```powershell
Set-Location C:\CiraCoreProject\fruitdefect
npm run build
```

เริ่ม PostgreSQL DEV:

```powershell
Set-Location C:\CiraCoreProject\fruitdefect
docker compose up -d db
```

## ไฟล์ที่ไม่ควรแก้หรือ commit โดยไม่จำเป็น

| Path | เหตุผล |
|---|---|
| `node_modules\` | Dependencies ที่ติดตั้งจาก npm |
| `.next\` | ไฟล์ที่ Next.js สร้างระหว่าง build/dev |
| `tsconfig.tsbuildinfo` | Cache ของ TypeScript |
| `next-dev.log` | Log จากการรัน development server |
| `next-dev-error.log` | Error log จาก development server |
| `.env.local` | อาจมี credentials หรือ secret |

## Path สำหรับงานที่จะเพิ่มภายหลัง

โครงสร้างที่แนะนำเมื่อเริ่มเชื่อม CIRA CORE และฐานข้อมูลจริง:

```text
src\
  adapters\       # แปลง output จากแต่ละ model เป็น event contract กลาง
  db\             # Database client และ repository
  ingest\         # รับและตรวจสอบ JSON จาก CIRA CORE
  sync\           # Offline -> Online sync และป้องกัน event ซ้ำ
  reports\        # Logic สำหรับรายงานและการวิเคราะห์
```

การเพิ่ม schema และ table ต้องรอการยืนยัน JSON contract จาก CIRA CORE ก่อน
