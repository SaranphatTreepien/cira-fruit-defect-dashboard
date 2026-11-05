import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';

export const dynamic = 'force-dynamic';

// Lightweight poll for the notification bell / pop-ups on every page.
// GET /api/alerts/feed            -> latest id + counts (no items, so old alerts do not pop up)
// GET /api/alerts/feed?after=123  -> alerts with id > 123 (oldest first, max 20)
export async function GET(request: NextRequest) {
  const after = Number(request.nextUrl.searchParams.get('after'));
  try {
    const [counts, items] = await Promise.all([
      pool.query(
        `SELECT COALESCE(max(id), 0)::bigint AS latest_id,
                count(*) FILTER (WHERE status = 'new' AND level <> 'info')::int AS unacked,
                count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
         FROM alerts`,
      ),
      Number.isFinite(after) && after >= 0 && request.nextUrl.searchParams.has('after')
        ? pool.query(
          `SELECT id, ts, rule, level, device_id, title, detail, resolved_at
           FROM alerts WHERE id > $1 ORDER BY id ASC LIMIT 20`,
          [after],
        )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);
    const c = counts.rows[0];
    return NextResponse.json({
      latest_id: Number(c.latest_id),
      unacked: c.unacked,
      open: c.open,
      items: items.rows.map((row) => ({
        ...row,
        id: Number(row.id),
        ts: row.ts ? new Date(row.ts as string).toISOString() : null,
        resolved_at: row.resolved_at ? new Date(row.resolved_at as string).toISOString() : null,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'feed failed' }, { status: 503 });
  }
}
