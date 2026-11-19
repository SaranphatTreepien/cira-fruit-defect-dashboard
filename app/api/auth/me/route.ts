import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';
import { currentUser } from '@/lib/auth';
import { ensureDemoUsers } from '@/lib/demo';

export const dynamic = 'force-dynamic';

// GET: the signed-in user, or { user: null, setup_required } when nobody is signed in.
export async function GET() {
  try {
    const user = await currentUser();
    if (user) return NextResponse.json({ user });
    await ensureDemoUsers();
    const count = await pool.query('SELECT count(*)::int AS n FROM users');
    return NextResponse.json({ user: null, setup_required: count.rows[0].n === 0 }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'auth check failed' }, { status: 503 });
  }
}
