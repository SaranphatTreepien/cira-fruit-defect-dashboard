// Dashboard login: scrypt password hashes + DB-backed sessions (cookie holds a random token,
// the DB keeps only its SHA-256). Every API route calls requireUser() before touching data.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { pool } from '@/db/pool';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'cira_session';
export const SESSION_DAYS = 7;
export type Role = 'admin' | 'viewer';
export type SessionUser = { id: number; email: string; name: string; role: Role };

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const passwordProblem = (password: unknown) =>
  typeof password !== 'string' || password.length < 8 ? 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' : password.length > 200 ? 'รหัสผ่านยาวเกินไป' : null;

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
    [tokenHash(token), userId, SESSION_DAYS],
  );
  await pool.query(`DELETE FROM user_sessions WHERE expires_at < now()`);
  return token;
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86400 });
}

export async function destroySession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) await pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash(token)]);
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [tokenHash(token)],
  );
  const row = result.rows[0];
  return row ? { id: Number(row.id), email: row.email, name: row.name, role: row.role } : null;
}

// Returns the signed-in user, or a 401/403 response to send back as is.
export async function requireUser(role?: Role): Promise<SessionUser | NextResponse> {
  let user: SessionUser | null;
  try {
    user = await currentUser();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'auth check failed' }, { status: 503 });
  }
  if (!user) return NextResponse.json({ error: 'ต้องเข้าสู่ระบบ' }, { status: 401 });
  if (role === 'admin' && user.role !== 'admin') return NextResponse.json({ error: 'ต้องเป็น Admin' }, { status: 403 });
  return user;
}

// Small in-memory brake on password guessing (per IP + email, resets after 15 min).
const failures = new Map<string, { n: number; first: number }>();
export function loginBlocked(key: string) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60_000) { failures.delete(key); return false; }
  return entry.n >= 8;
}
export function loginFailed(key: string) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > 15 * 60_000) failures.set(key, { n: 1, first: Date.now() });
  else entry.n += 1;
}
export const loginSucceeded = (key: string) => failures.delete(key);
