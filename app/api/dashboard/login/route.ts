// OzarEye
// Copyright (C) 2026 H. Soualmi
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

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
