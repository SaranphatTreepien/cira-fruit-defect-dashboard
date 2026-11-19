import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const RANGES: Record<string, string> = { '1h': '1 hour', '24h': '24 hours', '7d': '7 days' };

// What scripts/mqtt_to_db.py refused or dropped (it writes them to system_logs, source = mqtt_to_db):
//   BAD_MESSAGE reason=<why> payload=<first 200 chars>   -> rejected, not stored
//   DEDUP_TRACK dropped=<n> ...                           -> same fruit (run + track_id) sent again
// plus events that were stored but had a value the lookup tables don't know (column stored as NULL).
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const key = request.nextUrl.searchParams.get('range') ?? '24h';
  const range = RANGES[key] ?? RANGES['24h'];
  try {
    const [rejects, reasons, dedup, unknown, totals] = await Promise.all([
      pool.query(
        `SELECT id, ts, message FROM system_logs
         WHERE source = 'mqtt_to_db' AND message LIKE 'BAD_MESSAGE%' AND ts >= now() - $1::interval
         ORDER BY ts DESC LIMIT 100`,
        [range],
      ),
      pool.query(
        `SELECT COALESCE(substring(message FROM 'reason=(\\S+)'), 'unknown') AS reason, count(*)::int AS n
         FROM system_logs WHERE source = 'mqtt_to_db' AND message LIKE 'BAD_MESSAGE%' AND ts >= now() - $1::interval
         GROUP BY 1 ORDER BY 2 DESC`,
        [range],
      ),
      pool.query(
        `SELECT COALESCE(sum(substring(message FROM 'dropped=(\\d+)')::int), 0)::int AS dropped
         FROM system_logs WHERE source = 'mqtt_to_db' AND message LIKE 'DEDUP_TRACK%' AND ts >= now() - $1::interval`,
        [range],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE fruit_type IS NULL AND raw->>'fruit_type' IS NOT NULL)::int AS fruit,
                count(*) FILTER (WHERE defect_type IS NULL AND raw->>'defect_type' IS NOT NULL)::int AS defect,
                count(*) FILTER (WHERE model_version IS NULL AND raw->>'model_version' IS NOT NULL)::int AS model,
                count(*) FILTER (WHERE external_result = 'defect' AND defect_type IS NULL AND raw->>'defect_type' IS NULL)::int AS defect_untyped,
                count(*) FILTER (WHERE track_id IS NULL)::int AS no_track,
                array_remove(array_agg(DISTINCT raw->>'fruit_type') FILTER (WHERE fruit_type IS NULL), NULL) AS fruit_values,
                array_remove(array_agg(DISTINCT raw->>'defect_type') FILTER (WHERE defect_type IS NULL), NULL) AS defect_values,
                array_remove(array_agg(DISTINCT raw->>'model_version') FILTER (WHERE model_version IS NULL), NULL) AS model_values
         FROM fruit_events WHERE ts >= now() - $1::interval`,
        [range],
      ),
      pool.query(`SELECT count(*)::int AS n FROM fruit_events WHERE ts >= now() - $1::interval`, [range]),
    ]);
    const u = unknown.rows[0];
    return NextResponse.json({
      range: RANGES[key] ? key : '24h',
      stored: totals.rows[0].n,
      rejected: reasons.rows.reduce((sum, row) => sum + row.n, 0),
      dedup_dropped: dedup.rows[0].dropped,
      reasons: reasons.rows,
      unknown: {
        fruit: u.fruit, defect: u.defect, model: u.model, defect_untyped: u.defect_untyped, no_track: u.no_track,
        fruit_values: u.fruit_values ?? [], defect_values: u.defect_values ?? [], model_values: u.model_values ?? [],
      },
      rejects: rejects.rows.map((row) => {
        const match = /^BAD_MESSAGE reason=(.*?) payload=([\s\S]*)$/.exec(row.message as string);
        return { id: Number(row.id), ts: new Date(row.ts).toISOString(), reason: match?.[1] ?? '-', payload: match?.[2] ?? row.message };
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'data quality query failed' }, { status: 503 });
  }
}
