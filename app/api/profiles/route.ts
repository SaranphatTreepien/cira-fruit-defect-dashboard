import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Read-only reference data: fruit and defect types the system knows (lookup tables) with
// what was seen in the last 7 days, plus registered models. Detection settings live in CIRA CORE.
export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  try {
    const [fruits, defects, models] = await Promise.all([
      pool.query(
        `SELECT f.code, f.name_th, f.name_en, f.icon,
                count(e.*)::int AS total, count(e.*) FILTER (WHERE e.external_result = 'defect')::int AS defect,
                avg(CASE WHEN e.confidence <= 1 THEN e.confidence * 100 ELSE e.confidence END) AS avg_conf,
                max(e.ts) AS last_seen,
                (SELECT max(ts) FROM fruit_events a WHERE a.fruit_type = f.code) AS last_ever
         FROM fruit_types f LEFT JOIN fruit_events e ON e.fruit_type = f.code AND e.ts >= now() - interval '7 days'
         GROUP BY f.code ORDER BY f.code`,
      ),
      pool.query(
        `SELECT d.code, d.name_th, d.name_en, count(e.*)::int AS seen_7d
         FROM defect_types d LEFT JOIN fruit_events e ON e.defect_type = d.code AND e.ts >= now() - interval '7 days'
         GROUP BY d.code ORDER BY seen_7d DESC, d.code`,
      ),
      pool.query(
        `SELECT m.model_version, m.model_source, m.precision, m.recall, m.map, m.threshold, m.created_at,
                (SELECT max(ts) FROM fruit_events e WHERE e.model_version = m.model_version) AS last_seen
         FROM models m ORDER BY last_seen DESC NULLS LAST, m.created_at DESC`,
      ),
    ]);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const num = (value: unknown) => (value == null ? null : Number(value));
    return NextResponse.json({
      fruits: fruits.rows.map((row) => ({
        code: row.code, name_th: row.name_th, name_en: row.name_en, icon: row.icon,
        total_7d: row.total, defect_7d: row.defect, defect_rate_7d: row.total ? (row.defect / row.total) * 100 : null,
        avg_conf_7d: num(row.avg_conf), last_seen: iso(row.last_ever),
      })),
      defects: defects.rows.map((row) => ({ code: row.code, name_th: row.name_th, name_en: row.name_en, seen_7d: row.seen_7d })),
      models: models.rows.map((row) => ({
        model_version: row.model_version, model_source: row.model_source,
        precision: num(row.precision), recall: num(row.recall), map: num(row.map), threshold: num(row.threshold),
        created_at: iso(row.created_at), last_seen: iso(row.last_seen),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'profiles query failed' }, { status: 503 });
  }
}
