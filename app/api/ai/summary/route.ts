import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';

export const dynamic = 'force-dynamic';

// AI summary for the Alert & Reports page. Same idea as the Telegram bot's "AI สรุป":
// aggregated numbers only are sent to Gemini (no images, no secrets).
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const SYSTEM = `คุณคือผู้ช่วยของระบบคัดแยกผลไม้ CIRA CORE ตอบภาษาไทย สั้น กระชับ ใช้ตัวเลขจากข้อมูลที่ให้เท่านั้น ห้ามเดา
defect = เสีย, good = ดี, defect_type 'ไม่ระบุ' = โมเดลไม่ได้ส่งประเภทตำหนิ, ความหน่วง CIRA ถึง DB ปกติ 1-5 วินาที`;

const TODAY = `date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`;

async function gather(scope: 'today' | 'week') {
  const from = scope === 'today' ? TODAY : `now() - interval '7 days'`;
  const [prod, prev, daily, hourly, alerts, history, latency] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE external_result = 'defect')::int AS defect,
                       round((avg(confidence) * 100)::numeric, 1) AS avg_conf_pct
                FROM fruit_events WHERE ts >= ${from}`),
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE external_result = 'defect')::int AS defect
                FROM fruit_events WHERE ts >= ${scope === 'today' ? `${TODAY} - interval '1 day'` : `now() - interval '14 days'`} AND ts < ${from}`),
    pool.query(`SELECT to_char(ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS day, count(*)::int AS total,
                       count(*) FILTER (WHERE external_result = 'defect')::int AS defect
                FROM fruit_events WHERE ts >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT to_char(date_trunc('hour', ts AT TIME ZONE 'Asia/Bangkok'), 'DD/MM HH24:00') AS hour, count(*)::int AS total,
                       count(*) FILTER (WHERE external_result = 'defect')::int AS defect
                FROM fruit_events WHERE ts >= ${from} GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT to_char(ts AT TIME ZONE 'Asia/Bangkok', 'DD/MM HH24:MI') AS time, level, title, detail, resolved_at IS NOT NULL AS resolved
                FROM alerts WHERE ts >= ${from} AND level <> 'info' ORDER BY ts DESC LIMIT 25`),
    pool.query(`SELECT to_char(ts AT TIME ZONE 'Asia/Bangkok', 'DD/MM HH24:MI:SS') AS time, device_id, to_state
                FROM device_state_log WHERE ts >= ${from} ORDER BY ts DESC LIMIT 20`),
    pool.query(`SELECT round(avg(extract(epoch FROM created_at - ts))::numeric, 1) AS avg_sec FROM
                (SELECT created_at, ts FROM fruit_events ORDER BY created_at DESC LIMIT 50) t`),
  ]);
  return { scope, production: prod.rows[0], previous_period: prev.rows[0], daily_7d: daily.rows, hourly: scope === 'today' ? hourly.rows : undefined,
    alerts: alerts.rows, device_changes: history.rows, ingest_latency_avg_sec: latency.rows[0]?.avg_sec };
}

export async function POST(request: NextRequest) {
  const key = process.env.GEMINI_API_KEY || process.env.Gemeni_api_key;
  if (!key) return NextResponse.json({ error: 'ยังไม่ได้ตั้ง Gemeni_api_key ใน .env' }, { status: 503 });
  let scope: 'today' | 'week' = 'today';
  try { const body = await request.json() as { scope?: string }; if (body.scope === 'week') scope = 'week'; } catch { /* default */ }

  try {
    const data = await gather(scope);
    const prompt = `สรุป${scope === 'today' ? 'วันนี้' : '7 วันล่าสุด'}ของไลน์คัดแยกจากข้อมูล JSON นี้ แบ่งหัวข้อ: ภาพรวม · สถานะเครื่องและเหตุการณ์ · สิ่งที่ผิดปกติ · ข้อแนะนำ 1-3 ข้อ ไม่เกิน 12 บรรทัด ใช้ข้อความธรรมดา\n\n${JSON.stringify(data)}`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1000 } }),
      signal: AbortSignal.timeout(60000),
    });
    if (response.status === 429) return NextResponse.json({ error: 'AI ใช้โควตาฟรีเต็มแล้ว ลองใหม่ในอีกสักครู่' }, { status: 429 });
    const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
    if (!response.ok) return NextResponse.json({ error: `Gemini HTTP ${response.status} ${payload.error?.message?.slice(0, 120) ?? ''}` }, { status: 502 });
    const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
    return NextResponse.json({ scope, model: MODEL, text: text || 'ไม่มีคำตอบ', generated_at: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'AI summary failed' }, { status: 503 });
  }
}
