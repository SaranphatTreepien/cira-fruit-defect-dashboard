import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';

export async function GET() {
  try {
    const result = await pool.query(`
      SELECT device_id, source_type, state, last_seen, age_sec
      FROM device_status_live
      ORDER BY device_id
    `);

    return NextResponse.json({
      devices: result.rows.map((row) => ({
        device_id: row.device_id,
        source_type: row.source_type,
        state: row.state,
        last_seen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
        age_sec: row.age_sec == null ? null : Number(row.age_sec),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Device status query failed';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
