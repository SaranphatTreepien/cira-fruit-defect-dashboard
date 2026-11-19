import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const ALLOWED_WINDOWS = [5, 15, 60, 480, 1440];

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const requested = Number(request.nextUrl.searchParams.get('window'));
  const windowMin = ALLOWED_WINDOWS.includes(requested) ? requested : 15;

  // ?lite=1: only what the top bar / sidebar show on every page (machine state, events per minute,
  // current model) -- 3 small queries instead of the 7 the Live page needs.
  if (request.nextUrl.searchParams.get('lite') === '1') {
    try {
      const [device, rate, model] = await Promise.all([
        pool.query(`SELECT device_id, state FROM device_status_live ORDER BY last_seen DESC LIMIT 1`),
        pool.query(`SELECT count(*)::int AS n FROM fruit_events WHERE ts >= now() - interval '60 seconds'`),
        pool.query(`SELECT model_version FROM fruit_events ORDER BY ts DESC LIMIT 1`),
      ]);
      const d = device.rows[0];
      return NextResponse.json({
        device: d ? { device_id: d.device_id, state: d.state } : null,
        events_last_minute: rate.rows[0]?.n ?? 0,
        recent: model.rows.map((row) => ({ model_version: row.model_version })),
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Live query failed' }, { status: 503 });
    }
  }

  try {
    const [device, last, byFruit, rate, recent, byDefect, latency] = await Promise.all([
      pool.query(`SELECT device_id, source_type, state, last_seen, age_sec
                  FROM device_status_live ORDER BY last_seen DESC LIMIT 1`),
      pool.query('SELECT max(ts) AS last_event_at FROM fruit_events'),
      pool.query(
        `SELECT COALESCE(fruit_type, 'unknown') AS fruit_type,
                count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'good')::int AS good,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect
         FROM fruit_events
         WHERE ts >= now() - ($1::int * interval '1 minute')
         GROUP BY 1 ORDER BY 2 DESC`,
        [windowMin],
      ),
      pool.query(`SELECT count(*)::int AS n FROM fruit_events WHERE ts >= now() - interval '60 seconds'`),
      pool.query(
        `SELECT event_id, ts, fruit_type, external_result, defect_type, confidence,
                track_id, camera_view, model_version, created_at
         FROM fruit_events ORDER BY ts DESC, created_at DESC LIMIT 30`,
      ),
      pool.query(
        `SELECT defect_type, count(*)::int AS n FROM fruit_events
         WHERE external_result = 'defect' AND ts >= now() - ($1::int * interval '1 minute')
         GROUP BY 1 ORDER BY 2 DESC`,
        [windowMin],
      ),
      // ingest delay = time from CIRA event timestamp to row written in DB (last 50 events)
      pool.query(
        `SELECT avg(d) AS avg_s, max(d) AS max_s, count(*)::int AS n FROM (
           SELECT extract(epoch FROM created_at - ts) AS d FROM fruit_events
           ORDER BY created_at DESC LIMIT 50) t`,
      ),
    ]);

    const d = device.rows[0];
    const fruits = byFruit.rows as { fruit_type: string; total: number; good: number; defect: number }[];
    const sum = (key: 'total' | 'good' | 'defect') => fruits.reduce((acc, row) => acc + row[key], 0);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

    return NextResponse.json({
      now: new Date().toISOString(),
      window_min: windowMin,
      device: d
        ? {
            device_id: d.device_id,
            source_type: d.source_type,
            state: d.state,
            last_seen: iso(d.last_seen),
            age_sec: d.age_sec == null ? null : Number(d.age_sec),
          }
        : null,
      last_event_at: iso(last.rows[0]?.last_event_at),
      totals: { total: sum('total'), good: sum('good'), defect: sum('defect') },
      by_fruit: fruits,
      by_defect: byDefect.rows.map((row) => ({ defect_type: row.defect_type ?? 'ไม่ระบุ', n: row.n })),
      events_last_minute: rate.rows[0]?.n ?? 0,
      recent: recent.rows.map((row) => ({
        event_id: row.event_id,
        ts: iso(row.ts),
        fruit_type: row.fruit_type,
        external_result: row.external_result,
        defect_type: row.defect_type,
        confidence: row.confidence == null ? null : Number(row.confidence),
        track_id: row.track_id,
        camera_view: row.camera_view,
        model_version: row.model_version,
        created_at: iso(row.created_at),
      })),
      ingest_latency: {
        avg_s: latency.rows[0]?.avg_s == null ? null : Number(latency.rows[0].avg_s),
        max_s: latency.rows[0]?.max_s == null ? null : Number(latency.rows[0].max_s),
        n: latency.rows[0]?.n ?? 0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live query failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
