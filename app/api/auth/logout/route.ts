import { NextResponse } from 'next/server';
import { destroySession, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  try { await destroySession(); } catch { /* cookie is cleared below either way */ }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
