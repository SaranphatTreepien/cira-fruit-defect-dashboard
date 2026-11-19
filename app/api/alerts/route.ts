import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const RANGES: Record<string, string> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

// GET: alert inbox + counts + machine on/off history + watcher heartbeat.
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const params = request.nextUrl.searchParams;
  const range = RANGES[params.get('range') ?? ''] ?? RANGES['7d'];
  const status = params.get('status') ?? 'all'; // open | new | resolved | all
  const level = params.get('level');
  const where = ['ts >= now() - $1::interval'];
  const values: unknown[] = [range];
  if (status === 'open') where.push('resolved_at IS NULL');
  if (status === 'new') where.push("status = 'new'");
  if (status === 'resolved') where.push('resolved_at IS NOT NULL');
  if (level && ['info', 'warning', 'critical'].includes(level)) { values.push(level); where.push(`level = $${values.length}`); }

  try {
    const [alerts, counts, history, watcher] = await Promise.all([
      pool.query(
        `SELECT id, ts, rule, level, device_id, title, detail, data, status, acked_at, acked_by, resolved_at, notify_status
         FROM alerts WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 200`,
        values,
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
                count(*) FILTER (WHERE resolved_at IS NULL AND level = 'critical')::int AS open_critical,
                count(*) FILTER (WHERE status = 'new' AND level <> 'info')::int AS unacked,
                count(*) FILTER (WHERE ts >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')::int AS today,
                count(*) FILTER (WHERE notify_status = 'pending')::int AS notify_pending
         FROM alerts`,
      ),
      pool.query(
        `SELECT id, ts, device_id, from_state, to_state, age_sec,
                extract(epoch FROM (lead(ts) OVER (PARTITION BY device_id ORDER BY ts) - ts)) AS duration_sec
         FROM device_state_log ORDER BY ts DESC LIMIT 30`,
      ),
      pool.query(`SELECT value, updated_at, extract(epoch FROM now() - updated_at) AS age_sec FROM settings WHERE key = 'alert_watcher'`),
    ]);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const w = watcher.rows[0];
    return NextResponse.json({
      alerts: alerts.rows.map((row) => ({ ...row, id: Number(row.id), ts: iso(row.ts), acked_at: iso(row.acked_at), resolved_at: iso(row.resolved_at) })),
      counts: counts.rows[0],
      history: history.rows.map((row) => ({ ...row, id: Number(row.id), ts: iso(row.ts), age_sec: row.age_sec == null ? null : Number(row.age_sec), duration_sec: row.duration_sec == null ? null : Number(row.duration_sec) })),
      watcher: w ? { running: Number(w.age_sec) < 30, last_seen: iso(w.updated_at), age_sec: Math.round(Number(w.age_sec)) } : { running: false, last_seen: null, age_sec: null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Alert query failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

// POST { action: 'ack', ids: number[] } or { action: 'ack_all' } -- acknowledge alerts as the signed-in user.
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  let body: { action?: string; ids?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const by = auth.name;
  try {
    if (body.action === 'ack_all') {
      const result = await pool.query(`UPDATE alerts SET status = 'ack', acked_at = now(), acked_by = $1, acked_by_user = $2 WHERE status = 'new'`, [by, auth.id]);
      return NextResponse.json({ updated: result.rowCount });
    }
    if (body.action === 'ack' && Array.isArray(body.ids)) {
      const ids = body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 500);
      if (!ids.length) return NextResponse.json({ error: 'no ids' }, { status: 400 });
      const result = await pool.query(`UPDATE alerts SET status = 'ack', acked_at = now(), acked_by = $2, acked_by_user = $3 WHERE id = ANY($1::bigint[]) AND status = 'new'`, [ids, by, auth.id]);
      return NextResponse.json({ updated: result.rowCount });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Alert update failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
