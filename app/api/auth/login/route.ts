import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { createSession, loginBlocked, loginFailed, loginSucceeded, setSessionCookie, verifyPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// POST { email, password } -> sets the session cookie.
export async function POST(request: NextRequest) {
  let body: { email?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return NextResponse.json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' }, { status: 400 });

  const key = `${request.headers.get('x-forwarded-for') ?? request.ip ?? 'local'}|${email}`;
  if (loginBlocked(key)) return NextResponse.json({ error: 'ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่' }, { status: 429 });
  try {
    const result = await pool.query('SELECT id, name, role, password_hash, active FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      loginFailed(key);
      return NextResponse.json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' }, { status: 401 });
    }
    loginSucceeded(key);
    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const response = NextResponse.json({ user: { id: Number(user.id), email, name: user.name, role: user.role } });
    setSessionCookie(response, await createSession(Number(user.id)));
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'login failed' }, { status: 503 });
  }
}
