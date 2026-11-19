import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { createSession, hashPassword, passwordProblem, setSessionCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// POST { name, email, password } -- creates the first Admin. Refused once any user exists.
export async function POST(request: NextRequest) {
  let body: { name?: unknown; email?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 120) : '';
  if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) return NextResponse.json({ error: 'กรอกชื่อและอีเมลให้ถูกต้อง' }, { status: 400 });
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const count = await client.query('SELECT count(*)::int AS n FROM users');
    if (count.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'มีผู้ใช้อยู่แล้ว · ให้ Admin เพิ่มบัญชีให้' }, { status: 409 });
    }
    const inserted = await client.query(
      `INSERT INTO users (email, name, role, password_hash, last_login_at) VALUES ($1, $2, 'admin', $3, now()) RETURNING id`,
      [email, name, await hashPassword(body.password as string)],
    );
    await client.query('COMMIT');
    const id = Number(inserted.rows[0].id);
    const response = NextResponse.json({ user: { id, email, name, role: 'admin' } });
    setSessionCookie(response, await createSession(id));
    return response;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'setup failed' }, { status: 503 });
  } finally {
    client.release();
  }
}
