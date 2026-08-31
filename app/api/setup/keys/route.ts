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

import { isAuthenticated } from '@/lib/dashboard-auth';
import { SECRET_KEYS, secretsConfigured, writeSecrets, type SecretKey } from '@/lib/env-secrets';

// Writes secrets straight to .env.local server-side. The request body is
// never logged (Next/vinext's default access log doesn't include bodies, and
// nothing here calls console.log on it), and the response only ever reports
// which keys are now non-empty — the values themselves never come back.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return Response.json({ error: 'Requête invalide' }, { status: 400 }); }

  const values: Partial<Record<SecretKey, string>> = {};
  for (const key of SECRET_KEYS) {
    const value = body[key];
    if (typeof value === 'string') values[key] = value;
  }
  if (Object.keys(values).length === 0) return Response.json({ error: 'Aucune clé fournie' }, { status: 400 });

  writeSecrets(values);
  return Response.json({ ok: true, secretsConfigured: secretsConfigured() });
}
