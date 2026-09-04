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

import { activeEvents, getConfig, getSourceHealth } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { toDashboardEvent } from '@/lib/dashboard-view';
import { FIRMS_SOURCES, MTG_SOURCE, SLSTR_SOURCE } from '@/lib/fire-monitor';
import { satelliteName } from '@/lib/satellite-names';

// The 3 FIRMS/VIIRS sources plus Meteosat and SLSTR — kept as a separate
// concat rather than editing FIRMS_SOURCES itself, since that constant is
// also reused by app/api/monitor/route.ts's crash-path (which lists
// MTG_SOURCE/SLSTR_SOURCE alongside it there too, but the two lists serve
// different call sites, not one shared one).
const ALL_SOURCES = [...FIRMS_SOURCES, MTG_SOURCE, SLSTR_SOURCE];

// Read-only: pulls stored events from the DB only. Never calls FIRMS, never
// sends Telegram — that's /api/monitor's job, untouched by this route.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const wilaya = url.searchParams.get('wilaya');

  const [events, config, health] = await Promise.all([
    activeEvents(24),
    getConfig(),
    Promise.all(ALL_SOURCES.map(async source => ({ source, name: satelliteName(source), row: await getSourceHealth(source) }))),
  ]);
  const mapped = events.map(e => toDashboardEvent(e, undefined, config.frpThresholdMw, config.proximityKm)).filter(e => !wilaya || wilaya === 'all' || e.wilaya === wilaya);

  // updatedAt is when this page was served; lastSyncAt is when the monitor
  // last actually got data out of FIRMS. They diverge exactly when something
  // is wrong, which is the case worth surfacing — so both are sent, and the
  // header labels them differently.
  const sources = health.map(({ source, name, row }) => ({
    source, name,
    ok: !row?.incidentOpenSince,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    downSince: row?.incidentOpenSince ?? null,
  }));
  const successes = sources.map(s => s.lastSuccessAt).filter((v): v is string => !!v).sort();
  return Response.json({ events: mapped, updatedAt: new Date().toISOString(), lastSyncAt: successes[successes.length - 1] ?? null, sources });
}
