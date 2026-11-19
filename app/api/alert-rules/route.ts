import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// Shape and limits of settings.alert_rules (read by scripts/alert_watcher.py every 10 s).
const SCHEMA: Record<string, Record<string, [number, number] | 'bool' | 'level'>> = {
  defect_rate: { enabled: 'bool', threshold_pct: [1, 100], window_min: [1, 240], min_events: [1, 10000] },
  no_events: { enabled: 'bool', after_sec: [10, 3600] },
  latency: { enabled: 'bool', avg_sec: [1, 600] },
  device: { enabled: 'bool', notify_online: 'bool' },
  mqtt: { enabled: 'bool' },
  internet: { enabled: 'bool' },
  writer: { enabled: 'bool' },
  telegram: { enabled: 'bool', min_level: 'level' },
  model_change: { enabled: 'bool' },
  daily_report: { enabled: 'bool', hour: [0, 23], minute: [0, 59] },
};

export async function GET() {
  const auth = await requireUser();
  if (auth instanceof NextResponse) return auth;
  try {
    const result = await pool.query(`SELECT value, updated_at FROM settings WHERE key = 'alert_rules'`);
    return NextResponse.json({ rules: result.rows[0]?.value ?? null, updated_at: result.rows[0]?.updated_at ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'query failed' }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireUser('admin');
  if (auth instanceof NextResponse) return auth;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const input = (body as { rules?: Record<string, Record<string, unknown>> })?.rules;
  if (!input || typeof input !== 'object') return NextResponse.json({ error: 'rules required' }, { status: 400 });

  const clean: Record<string, Record<string, number | boolean | string>> = {};
  for (const [group, fields] of Object.entries(SCHEMA)) {
    clean[group] = {};
    for (const [field, spec] of Object.entries(fields)) {
      const value = input[group]?.[field];
      if (spec === 'level') {
        if (value !== 'info' && value !== 'warning' && value !== 'critical') return NextResponse.json({ error: `${group}.${field} must be info / warning / critical` }, { status: 400 });
        clean[group][field] = value;
      } else if (spec === 'bool') {
        if (typeof value !== 'boolean') return NextResponse.json({ error: `${group}.${field} must be true/false` }, { status: 400 });
        clean[group][field] = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n < spec[0] || n > spec[1]) return NextResponse.json({ error: `${group}.${field} ต้องอยู่ระหว่าง ${spec[0]}–${spec[1]}` }, { status: 400 });
        clean[group][field] = n;
      }
    }
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('alert_rules', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(clean)],
    );
    return NextResponse.json({ rules: clean });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'save failed' }, { status: 503 });
  }
}
