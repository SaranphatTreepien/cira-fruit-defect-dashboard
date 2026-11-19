import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const RANGES: Record<string, string | null> = { '24h': '24 hours', '7d': '7 days', '30d': '30 days', all: null };

// Per-model comparison. The model is whatever model_version CIRA CORE put in each event
// (falls back to the raw JSON when the column is NULL because the version was unknown).
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const key = request.nextUrl.searchParams.get('range') ?? '7d';
  const range = key in RANGES ? RANGES[key] : RANGES['7d'];
  const where = range ? `WHERE ts >= now() - $1::interval` : '';
  const values = range ? [range] : [];
  const model = `COALESCE(model_version, raw->>'model_version', 'unknown')`;
  try {
    const [summary, byFruit, meta] = await Promise.all([
      pool.query(
        `SELECT ${model} AS model, max(COALESCE(model_source, raw->>'model_source')) AS source,
                count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect,
                avg(CASE WHEN confidence <= 1 THEN confidence * 100 ELSE confidence END) AS avg_conf,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY CASE WHEN confidence <= 1 THEN confidence * 100 ELSE confidence END) AS median_conf,
                count(*) FILTER (WHERE confidence IS NOT NULL AND (CASE WHEN confidence <= 1 THEN confidence * 100 ELSE confidence END) < 60)::int AS low_conf,
                count(*) FILTER (WHERE external_result = 'defect' AND defect_type IS NULL)::int AS defect_untyped,
                min(ts) AS first_seen, max(ts) AS last_seen
         FROM fruit_events ${where} GROUP BY 1 ORDER BY max(ts) DESC`,
        values,
      ),
      pool.query(
        `SELECT ${model} AS model, COALESCE(fruit_type, 'unknown') AS fruit,
                count(*)::int AS total, count(*) FILTER (WHERE external_result = 'defect')::int AS defect
         FROM fruit_events ${where} GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
        values,
      ),
      pool.query(`SELECT model_version, model_source, precision, recall, map, threshold, created_at FROM models`),
    ]);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const num = (value: unknown) => (value == null ? null : Number(value));
    const metaBy = new Map(meta.rows.map((row) => [row.model_version, row]));
    return NextResponse.json({
      range: key in RANGES ? key : '7d',
      models: summary.rows.map((row) => {
        const m = metaBy.get(row.model);
        return {
          model: row.model,
          source: m?.model_source ?? row.source ?? null,
          total: row.total,
          defect: row.defect,
          defect_rate: row.total ? (row.defect / row.total) * 100 : null,
          avg_conf: num(row.avg_conf),
          median_conf: num(row.median_conf),
          low_conf_pct: row.total ? (row.low_conf / row.total) * 100 : null,
          defect_untyped: row.defect_untyped,
          first_seen: iso(row.first_seen),
          last_seen: iso(row.last_seen),
          registered: Boolean(m),
          metrics: m ? { precision: num(m.precision), recall: num(m.recall), map: num(m.map), threshold: num(m.threshold) } : null,
          by_fruit: byFruit.rows.filter((f) => f.model === row.model).map((f) => ({ fruit: f.fruit, total: f.total, defect: f.defect, defect_rate: f.total ? (f.defect / f.total) * 100 : null })),
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'models query failed' }, { status: 503 });
  }
}
