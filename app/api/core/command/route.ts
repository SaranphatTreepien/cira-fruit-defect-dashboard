import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const deviceOf = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null);

// GET ?device_id=CAM_01 -> { device_id, run }. Polled by the CIRA flow's Python box, which has no login,
// so this read is open; it only says whether the device may run (default true when never set).
export async function GET(request: NextRequest) {
  const device = deviceOf(request.nextUrl.searchParams.get('device_id'));
  if (!device) return NextResponse.json({ error: 'device_id ไม่ถูกต้อง' }, { status: 400 });
  try {
    const result = await pool.query(
      `SELECT c.run, c.updated_at, u.name AS updated_by
       FROM device_commands c LEFT JOIN users u ON u.id = c.updated_by WHERE c.device_id = $1`,
      [device],
    );
    const row = result.rows[0];
    return NextResponse.json({
      device_id: device,
      run: row ? row.run : true,
      updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_by: row?.updated_by ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'command query failed' }, { status: 503 });
  }
}

// POST { device_id, run } (admin): pause or resume the device's flow.
export async function POST(request: NextRequest) {
  const auth = await requireUser('admin');
  if (auth instanceof NextResponse) return auth;
  const body = await request.json().catch(() => ({})) as { device_id?: unknown; run?: unknown };
  const device = deviceOf(body.device_id);
  if (!device || typeof body.run !== 'boolean') return NextResponse.json({ error: 'ต้องมี device_id และ run (true/false)' }, { status: 400 });
  try {
    await pool.query(
      `INSERT INTO device_commands (device_id, run, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (device_id) DO UPDATE SET run = EXCLUDED.run, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [device, body.run, auth.id],
    );
    return NextResponse.json({ device_id: device, run: body.run });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'command update failed' }, { status: 503 });
  }
}
