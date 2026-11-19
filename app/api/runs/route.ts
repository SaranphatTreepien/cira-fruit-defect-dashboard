import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Work runs, cut automatically from device_state_log (CIRA CORE is started / stopped by hand):
// a run starts when a device goes into playing/started from any other state and ends at the next
// non-running state (offline / end / ...). Production in the run = fruit_events between the two.
// fruit_events has no device column, so with several cameras running at once the counts overlap.
// The watcher notices a state change on its 2 s poll, so events are counted from up to 10 s before
// the logged start (never before the previous run of that device ended).
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get('days')) || 7));
  try {
    const result = await pool.query(
      `WITH s AS (
         SELECT device_id, ts, to_state, to_state IN ('playing', 'started') AS up,
                lag(to_state IN ('playing', 'started')) OVER (PARTITION BY device_id ORDER BY ts) AS prev_up
         FROM device_state_log),
       starts AS (SELECT device_id, ts AS start_ts FROM s WHERE up AND prev_up IS DISTINCT FROM true),
       runs AS (
         SELECT st.device_id, st.start_ts, e.ts AS end_ts, e.to_state AS end_state
         FROM starts st
         LEFT JOIN LATERAL (SELECT ts, to_state FROM s WHERE s.device_id = st.device_id AND s.ts > st.start_ts AND NOT s.up
                            ORDER BY ts LIMIT 1) e ON true
         WHERE COALESCE(e.ts, now()) >= now() - ($1::int * interval '1 day')),
       runs_w AS (
         SELECT *, GREATEST(start_ts - interval '10 seconds',
                            COALESCE(lag(end_ts) OVER (PARTITION BY device_id ORDER BY start_ts), '-infinity')) AS count_from
         FROM runs)
       SELECT r.device_id, r.start_ts, r.end_ts, r.end_state,
              extract(epoch FROM COALESCE(r.end_ts, now()) - r.start_ts) AS duration_sec,
              ev.total, ev.good, ev.defect, ev.avg_conf, ev.models, ev.first_event, ev.last_event,
              (SELECT count(*)::int FROM alerts a WHERE a.level <> 'info' AND a.ts >= r.start_ts AND a.ts < COALESCE(r.end_ts, now())) AS alerts
       FROM runs_w r
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'good')::int AS good,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect,
                avg(confidence) AS avg_conf,
                array_remove(array_agg(DISTINCT COALESCE(model_version, raw->>'model_version')), NULL) AS models,
                min(ts) AS first_event, max(ts) AS last_event
         FROM fruit_events WHERE ts >= r.count_from AND ts < COALESCE(r.end_ts, now())) ev ON true
       ORDER BY r.start_ts DESC LIMIT 200`,
      [days],
    );
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const pct = (value: unknown) => (value == null ? null : Number(value) <= 1 ? Number(value) * 100 : Number(value));
    const runs = result.rows.map((row) => {
      const durationSec = Math.max(0, Number(row.duration_sec));
      return {
        device_id: row.device_id,
        start: iso(row.start_ts),
        end: iso(row.end_ts),
        end_state: row.end_state,
        running: row.end_ts == null,
        duration_sec: Math.round(durationSec),
        total: row.total,
        good: row.good,
        defect: row.defect,
        defect_rate: row.total ? (row.defect / row.total) * 100 : null,
        avg_conf: pct(row.avg_conf),
        per_min: durationSec >= 30 ? row.total / (durationSec / 60) : null,
        models: row.models ?? [],
        first_event: iso(row.first_event),
        last_event: iso(row.last_event),
        alerts: row.alerts,
      };
    });
    const since = await pool.query('SELECT min(ts) AS since FROM device_state_log');
    return NextResponse.json({ days, runs, history_since: iso(since.rows[0]?.since) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'runs query failed' }, { status: 503 });
  }
}
