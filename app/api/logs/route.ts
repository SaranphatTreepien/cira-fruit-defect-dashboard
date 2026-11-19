import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';
import { bucketFor, buildWhere, parseFilters } from '@/lib/logQuery';

export const dynamic = 'force-dynamic';

const PAGE_SIZES = [25, 50, 100];
const OPTIONS_TTL_MS = 60_000;
let optionsCache: { at: number; rows: { kind: string; value: string }[] } | null = null;

async function loadOptions() {
  if (optionsCache && Date.now() - optionsCache.at < OPTIONS_TTL_MS) return { rows: optionsCache.rows };
  const result = await pool.query(`SELECT 'fruit' AS kind, code AS value FROM fruit_types
         UNION SELECT 'fruit', fruit_type FROM fruit_events WHERE fruit_type IS NOT NULL
         UNION SELECT 'defect', code FROM defect_types
         UNION SELECT 'defect', defect_type FROM fruit_events WHERE defect_type IS NOT NULL
         UNION SELECT 'model', model_version FROM models
         UNION SELECT 'model', model_version FROM fruit_events WHERE model_version IS NOT NULL
         UNION SELECT 'camera', camera_view FROM fruit_events WHERE camera_view IS NOT NULL
         ORDER BY 1, 2`);
  optionsCache = { at: Date.now(), rows: result.rows };
  return { rows: result.rows };
}

// Bucket origin at Bangkok midnight so hourly/daily bars line up with local time.
const ORIGIN = `'2000-01-01 00:00:00+07'::timestamptz`;

export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const params = request.nextUrl.searchParams;
  const filters = parseFilters(params);
  const { sql: where, params: values } = buildWhere(filters);
  const pageSize = PAGE_SIZES.includes(Number(params.get('page_size'))) ? Number(params.get('page_size')) : 25;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const order = params.get('sort') === 'asc' ? 'ASC' : 'DESC';
  const bucket = bucketFor(filters);
  const n = values.length;

  try {
    const [summary, rows, trend, peak, byFruit, byDefect, byModel, options] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'good')::int AS good,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect,
                avg(confidence) AS avg_conf,
                count(*) FILTER (WHERE nir_result IS NOT NULL AND nir_result <> 'not_supported')::int AS with_nir,
                min(ts) AS first_ts, max(ts) AS last_ts
         FROM fruit_events WHERE ${where}`,
        values,
      ),
      pool.query(
        `SELECT event_id, ts, fruit_type, external_result, defect_type, nir_result, confidence,
                track_id, camera_view, model_version, model_source, synced
         FROM fruit_events WHERE ${where}
         ORDER BY ts ${order}, event_id ${order}
         LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...values, pageSize, (page - 1) * pageSize],
      ),
      pool.query(
        `WITH b AS (
           SELECT date_bin($${n + 1}::interval, ts, ${ORIGIN}) AS bucket,
                  count(*) FILTER (WHERE external_result = 'good')::int AS good,
                  count(*) FILTER (WHERE external_result = 'defect')::int AS defect,
                  count(*)::int AS total
           FROM fruit_events WHERE ${where} GROUP BY 1)
         SELECT s AS bucket, COALESCE(b.good, 0) AS good, COALESCE(b.defect, 0) AS defect, COALESCE(b.total, 0) AS total
         FROM generate_series(date_bin($${n + 1}::interval, $1::timestamptz, ${ORIGIN}), $2::timestamptz - interval '1 microsecond', $${n + 1}::interval) s
         LEFT JOIN b ON b.bucket = s ORDER BY s`,
        [...values, bucket.interval],
      ),
      pool.query(
        `SELECT to_char(date_trunc('hour', ts AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD HH24:00') AS hour, count(*)::int AS total
         FROM fruit_events WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1 DESC LIMIT 1`,
        values,
      ),
      pool.query(
        `SELECT COALESCE(fruit_type, 'ไม่ระบุ') AS key, count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect
         FROM fruit_events WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
        values,
      ),
      pool.query(
        `SELECT COALESCE(defect_type, 'ไม่ระบุ') AS key, count(*)::int AS total
         FROM fruit_events WHERE ${where} AND external_result = 'defect' GROUP BY 1 ORDER BY 2 DESC`,
        values,
      ),
      pool.query(
        `SELECT COALESCE(model_version, 'ไม่ระบุ') AS key, count(*)::int AS total,
                count(*) FILTER (WHERE external_result = 'defect')::int AS defect, avg(confidence) AS avg_conf
         FROM fruit_events WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
        values,
      ),
      // Filter dropdown options change rarely: cached for 60 s (full-table DISTINCT).
      loadOptions(),
    ]);

    const s = summary.rows[0];
    const total = s?.total ?? 0;
    const avgConf = s?.avg_conf == null ? null : Number(s.avg_conf);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const opt = (kind: string) => options.rows.filter((row) => row.kind === kind).map((row) => row.value as string);

    return NextResponse.json({
      range: { from: filters.from.toISOString(), to: filters.to.toISOString() },
      summary: {
        total,
        good: s?.good ?? 0,
        defect: s?.defect ?? 0,
        avg_conf: avgConf == null ? null : avgConf <= 1 ? avgConf * 100 : avgConf,
        nir_coverage: total ? (s.with_nir / total) * 100 : null,
        first_ts: iso(s?.first_ts),
        last_ts: iso(s?.last_ts),
      },
      peak_hour: peak.rows[0] ? { hour: String(peak.rows[0].hour), total: peak.rows[0].total } : null,
      trend: { bucket: bucket.label, points: trend.rows.map((row) => ({ t: iso(row.bucket), good: Number(row.good), defect: Number(row.defect), total: Number(row.total) })) },
      by_fruit: byFruit.rows,
      by_defect: byDefect.rows,
      by_model: byModel.rows.map((row) => ({ ...row, avg_conf: row.avg_conf == null ? null : Number(row.avg_conf) <= 1 ? Number(row.avg_conf) * 100 : Number(row.avg_conf) })),
      options: { fruit: opt('fruit'), defect: opt('defect'), model: opt('model'), camera: opt('camera') },
      page: { page, page_size: pageSize, total_rows: total, page_count: Math.max(1, Math.ceil(total / pageSize)) },
      rows: rows.rows.map((row) => ({
        ...row,
        ts: iso(row.ts),
        confidence: row.confidence == null ? null : Number(row.confidence),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Log query failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
