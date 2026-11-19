import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { hashPassword, passwordProblem, requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// PATCH { name?, role?, active?, password? } -- Admin edits a user.
// Guard: the last active Admin can't be demoted or disabled (nobody could manage users after that).
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser('admin');
  if (auth instanceof NextResponse) return auth;
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  let body: { name?: unknown; role?: unknown; active?: unknown; password?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }

  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => { values.push(value); sets.push(`${sql} = $${values.length}`); };
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    if (!name) return NextResponse.json({ error: 'ชื่อว่างไม่ได้' }, { status: 400 });
    add('name', name);
  }
  if (body.role !== undefined) {
    if (body.role !== 'admin' && body.role !== 'viewer') return NextResponse.json({ error: 'role ต้องเป็น admin หรือ viewer' }, { status: 400 });
    add('role', body.role);
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return NextResponse.json({ error: 'active ต้องเป็น true/false' }, { status: 400 });
    add('active', body.active);
  }
  if (body.password !== undefined) {
    const problem = passwordProblem(body.password);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    add('password_hash', await hashPassword(body.password as string));
  }
  if (!sets.length) return NextResponse.json({ error: 'ไม่มีอะไรให้แก้' }, { status: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    values.push(id);
    const updated = await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`, values);
    if (!updated.rowCount) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'ไม่พบผู้ใช้' }, { status: 404 }); }
    const admins = await client.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
    if (admins.rows[0].n === 0) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'ต้องมี Admin ที่ใช้งานได้อย่างน้อย 1 คน' }, { status: 409 }); }
    // Disabled or password changed: sign that user out everywhere.
    if (body.active === false || body.password !== undefined) {
      await client.query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
    }
    await client.query('COMMIT');
    return NextResponse.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'update failed' }, { status: 503 });
  } finally {
    client.release();
  }
}
