import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { hashPassword, passwordProblem, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

// GET: all users (Admin) with how many alerts each acknowledged.
export async function GET() {
  const auth = await requireUser('admin');
  if (auth instanceof NextResponse) return auth;
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login_at,
              (SELECT count(*)::int FROM alerts a WHERE a.acked_by_user = u.id) AS acks
       FROM users u ORDER BY u.created_at`,
    );
    return NextResponse.json({
      users: result.rows.map((row) => ({ ...row, id: Number(row.id), created_at: iso(row.created_at), last_login_at: iso(row.last_login_at) })),
      me: auth.id,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'query failed' }, { status: 503 });
  }
}

// POST { name, email, role, password } -- Admin adds a user.
export async function POST(request: NextRequest) {
  const auth = await requireUser('admin');
  if (auth instanceof NextResponse) return auth;
  let body: { name?: unknown; email?: unknown; role?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 120) : '';
  const role = body.role === 'admin' ? 'admin' : body.role === 'viewer' ? 'viewer' : null;
  if (!name || !/^[^\s@]+@[^\s@]+$/.test(email) || !role) return NextResponse.json({ error: 'กรอกชื่อ อีเมล และ role ให้ถูกต้อง' }, { status: 400 });
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  try {
    const result = await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, name, role, await hashPassword(body.password as string)],
    );
    if (!result.rowCount) return NextResponse.json({ error: 'อีเมลนี้มีบัญชีแล้ว' }, { status: 409 });
    return NextResponse.json({ id: Number(result.rows[0].id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'create failed' }, { status: 503 });
  }
}
