// Demo account shown in a dropdown on the login page (fills email + password).
// The password is visible to anyone who can open the login page: set DEMO_LOGIN=0 in .env.local
// to turn it off, DEMO_ADMIN_PASSWORD to change it.
import { pool } from '@/db/pool';
import { hashPassword } from '@/lib/auth';

export const DEMO_ENABLED = process.env.DEMO_LOGIN !== '0';

export const DEMO_ACCOUNTS = [
  { label: 'Admin (demo)', email: 'admin@demo.local', name: 'Demo Admin', role: 'admin' as const, password: process.env.DEMO_ADMIN_PASSWORD || 'demo-admin-1234' },
];

let ensured = false;

// Creates the demo users, or puts their password / role back if someone changed them.
export async function ensureDemoUsers() {
  if (!DEMO_ENABLED || ensured) return;
  for (const account of DEMO_ACCOUNTS) {
    await pool.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, active = true`,
      [account.email, account.name, account.role, await hashPassword(account.password)],
    );
  }
  ensured = true;
}
