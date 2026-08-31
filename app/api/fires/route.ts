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

import { initDb, latestSignals } from '@/lib/database';

export async function GET() {
  try { await initDb(); return Response.json({signals: await latestSignals(), updatedAt: new Date().toISOString()}); }
  catch { return Response.json({signals: [], configured: false, message: 'Base de surveillance non configurée'}); }
}
