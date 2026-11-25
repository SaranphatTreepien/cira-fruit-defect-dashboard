import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Data for the report boards in the Live 3D scene, in one read-only call (polled every ~20 s):
// today's fruit per hour (Bangkok time) and the open alerts.
export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  try {
    const [hourly, open, counts] = await Promise.all([
      pool.query(
        `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AS d)
         SELECT extract(hour FROM e.ts AT TIME ZONE 'Asia/Bangkok')::int AS h,
                count(*) FILTER (WHERE e.external_result = 'good')::int AS good,
                count(*) FILTER (WHERE e.external_result = 'defect')::int AS defect
         FROM fruit_events e, day
         WHERE e.ts >= day.d AT TIME ZONE 'Asia/Bangkok' AND e.ts < (day.d + interval '1 day') AT TIME ZONE 'Asia/Bangkok'
         GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT id, ts, level, title, detail, device_id FROM alerts
         WHERE resolved_at IS NULL AND level <> 'info' ORDER BY ts DESC LIMIT 6`,
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL AND level <> 'info')::int AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND level = 'critical')::int AS open_critical,
                count(*) FILTER (WHERE level <> 'info' AND ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')::int AS today
         FROM alerts`,
      ),
    ]);
    const byHour = new Map(hourly.rows.map((r) => [Number(r.h), r]));
    return NextResponse.json({
      now: new Date().toISOString(),
      hourly: Array.from({ length: 24 }, (_, h) => ({ h, good: Number(byHour.get(h)?.good ?? 0), defect: Number(byHour.get(h)?.defect ?? 0) })),
      alerts: open.rows.map((r) => ({ id: Number(r.id), ts: r.ts ? new Date(r.ts).toISOString() : null, level: r.level, title: r.title, detail: r.detail, device_id: r.device_id })),
      alert_counts: counts.rows[0],
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'boards query failed' }, { status: 503 });
  }
}
