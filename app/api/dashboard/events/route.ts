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

import { activeEvents, getConfig } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { toDashboardEvent } from '@/lib/dashboard-view';

// Read-only: pulls stored events from the DB only. Never calls FIRMS, never
// sends Telegram — that's /api/monitor's job, untouched by this route.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const wilaya = url.searchParams.get('wilaya');

  const [events, config] = await Promise.all([activeEvents(24), getConfig()]);
  const mapped = events.map(e => toDashboardEvent(e, undefined, config.frpThresholdMw, config.proximityKm)).filter(e => !wilaya || wilaya === 'all' || e.wilaya === wilaya);
  return Response.json({ events: mapped, updatedAt: new Date().toISOString() });
}
