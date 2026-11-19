import { NextResponse } from 'next/server';
import { DEMO_ACCOUNTS, DEMO_ENABLED, ensureDemoUsers } from '@/lib/demo';

export const dynamic = 'force-dynamic';

// GET: demo accounts for the login page dropdown (empty when DEMO_LOGIN=0).
export async function GET() {
  if (!DEMO_ENABLED) return NextResponse.json({ accounts: [] });
  try {
    await ensureDemoUsers();
    return NextResponse.json({ accounts: DEMO_ACCOUNTS.map(({ label, email, password, role }) => ({ label, email, password, role })) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'demo setup failed' }, { status: 503 });
  }
}
