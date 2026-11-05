import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';

export const dynamic = 'force-dynamic';

// Daily summary (Bangkok days) for the last N days: production, defect rate, confidence,
// machine running time (from device_state_log) and alert counts.
export async function GET(request: NextRequest) {
  const days = Math.min(31, Math.max(1, Number(request.nextUrl.searchParams.get('days')) || 7));
  try {
    const result = await pool.query(
      `WITH d AS (
         SELECT generate_series(
                  date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') - ($1::int - 1) * interval '1 day',
                  date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok'), interval '1 day') AS day_local),
       days AS (
         SELECT day_local, day_local AT TIME ZONE 'Asia/Bangkok' AS day_start,
                (day_local + interval '1 day') AT TIME ZONE 'Asia/Bangkok' AS day_end FROM d),
       ev AS (
         SELECT days.day_local, count(e.*)::int AS total,
                count(e.*) FILTER (WHERE e.external_result = 'good')::int AS good,
                count(e.*) FILTER (WHERE e.external_result = 'defect')::int AS defect,
                avg(e.confidence) AS avg_conf,
                to_char(max(e.ts) AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') AS last_at
         FROM days LEFT JOIN fruit_events e ON e.ts >= days.day_start AND e.ts < days.day_end
         GROUP BY days.day_local),
       seg AS (
         SELECT to_state, ts AS s, COALESCE(lead(ts) OVER (PARTITION BY device_id ORDER BY ts), now()) AS e
         FROM device_state_log),
       up AS (
         SELECT days.day_local,
                COALESCE(sum(extract(epoch FROM (LEAST(seg.e, days.day_end) - GREATEST(seg.s, days.day_start))))
                  FILTER (WHERE seg.to_state IN ('playing', 'started') AND seg.e > days.day_start AND seg.s < days.day_end), 0) AS run_sec
         FROM days LEFT JOIN seg ON true GROUP BY days.day_local),
       al AS (
         SELECT days.day_local, count(a.*) FILTER (WHERE a.level <> 'info')::int AS alerts
         FROM days LEFT JOIN alerts a ON a.ts >= days.day_start AND a.ts < days.day_end GROUP BY days.day_local)
       SELECT to_char(ev.day_local, 'YYYY-MM-DD') AS day, ev.total, ev.good, ev.defect, ev.avg_conf, ev.last_at,
              up.run_sec, al.alerts
       FROM ev JOIN up USING (day_local) JOIN al USING (day_local) ORDER BY ev.day_local DESC`,
      [days],
    );
    const history = await pool.query('SELECT min(ts) AS since FROM device_state_log');
    return NextResponse.json({
      days: result.rows.map((row) => ({
        day: row.day,
        total: row.total,
        good: row.good,
        defect: row.defect,
        defect_rate: row.total ? (row.defect / row.total) * 100 : null,
        avg_conf: row.avg_conf == null ? null : Number(row.avg_conf) <= 1 ? Number(row.avg_conf) * 100 : Number(row.avg_conf),
        last_at: row.last_at,
        run_min: Math.round(Number(row.run_sec) / 60),
        alerts: row.alerts,
      })),
      run_history_since: history.rows[0]?.since ? new Date(history.rows[0].since).toISOString() : null,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'report query failed' }, { status: 503 });
  }
}
