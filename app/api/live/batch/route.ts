import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Events of one DB write batch. mqtt_to_db.py writes a batch in one transaction, so its rows share
// created_at. The browser only has it to the millisecond, so match the whole millisecond.
export async function GET(request: NextRequest) {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  const at = Date.parse(request.nextUrl.searchParams.get('created_at') ?? '');
  if (Number.isNaN(at)) return NextResponse.json({ error: 'created_at ไม่ถูกต้อง' }, { status: 400 });

  try {
    const result = await pool.query(
      `SELECT event_id, ts, fruit_type, external_result, defect_type, confidence,
              track_id, camera_view, model_version, created_at
       FROM fruit_events
       WHERE created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 millisecond'
       ORDER BY ts DESC LIMIT 500`,
      [new Date(at).toISOString()],
    );
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    return NextResponse.json({
      events: result.rows.map((row) => ({
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
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Batch query failed' }, { status: 503 });
  }
}
