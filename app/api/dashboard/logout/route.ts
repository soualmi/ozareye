import { clearSessionCookieHeader } from '@/lib/dashboard-auth';

export async function POST() {
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookieHeader() } });
}
