// Algérie Feux Alerte
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

import { eventsBetween } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { toDashboardEvent } from '@/lib/dashboard-view';

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) return Response.json({ error: 'Paramètres from/to requis' }, { status: 400 });

  const events = await eventsBetween(from, to);
  // Historical age is relative to the event's own detection time, not "now" —
  // otherwise a week-old event would show a nonsensical multi-day age.
  return Response.json({ events: events.map(e => toDashboardEvent(e, new Date(e.lastAcquiredAt))) });
}
