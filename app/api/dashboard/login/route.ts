import { sessionCookieHeader, verifyPassword } from '@/lib/dashboard-auth';

export async function POST(request: Request) {
  if (!process.env.DASHBOARD_PASSWORD) return Response.json({ error: 'Tableau de bord non configuré' }, { status: 503 });
  let password: string;
  try {
    const body = await request.json() as { password?: string };
    password = body.password ?? '';
  } catch {
    return Response.json({ error: 'Requête invalide' }, { status: 400 });
  }
  if (!password || !verifyPassword(password)) return Response.json({ error: 'Mot de passe incorrect' }, { status: 401 });
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': sessionCookieHeader() } });
}
