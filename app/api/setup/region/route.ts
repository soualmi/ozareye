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

import { isAuthenticated } from '@/lib/dashboard-auth';
import { clearFireHistory, getConfig, initDb, updateConfig } from '@/lib/database';

type RegionBody = {
  countryName?: unknown; countryIso2?: unknown; countryIso3?: unknown;
  bbox?: { west?: unknown; south?: unknown; east?: unknown; north?: unknown };
  frpThresholdMw?: unknown; proximityKm?: unknown; persistentSourceDays?: unknown;
};

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Saves country + bbox + tunables only — does NOT trigger the village/admin-
// boundary build (that's POST /api/setup/build, a separate, slow step with
// its own progress tracking). Splitting them lets the UI save tunable tweaks
// instantly without re-running Overpass every time.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  let body: RegionBody;
  try { body = await request.json() as RegionBody; }
  catch { return Response.json({ error: 'Requête invalide' }, { status: 400 }); }

  const west = num(body.bbox?.west), south = num(body.bbox?.south), east = num(body.bbox?.east), north = num(body.bbox?.north);
  if (west === null || south === null || east === null || north === null) return Response.json({ error: 'Zone (bbox) invalide' }, { status: 400 });
  if (west >= east || south >= north) return Response.json({ error: 'La zone doit avoir west < east et south < north' }, { status: 400 });

  await initDb();
  const current = await getConfig();
  const patch: Parameters<typeof updateConfig>[0] = { bbox: { west, south, east, north } };
  if (typeof body.countryName === 'string' && body.countryName) patch.countryName = body.countryName;
  if (typeof body.countryIso2 === 'string' && body.countryIso2) patch.countryIso2 = body.countryIso2;
  if (typeof body.countryIso3 === 'string' && body.countryIso3) patch.countryIso3 = body.countryIso3;
  const frpThresholdMw = num(body.frpThresholdMw); if (frpThresholdMw !== null && frpThresholdMw > 0) patch.frpThresholdMw = frpThresholdMw;
  const proximityKm = num(body.proximityKm); if (proximityKm !== null && proximityKm > 0) patch.proximityKm = proximityKm;
  const persistentSourceDays = num(body.persistentSourceDays); if (persistentSourceDays !== null && persistentSourceDays > 0) patch.persistentSourceDays = persistentSourceDays;

  // Changing the region invalidates the previous build's numbers even though
  // the old data files are still physically on disk until the next
  // successful /api/setup/build run — reflect that in the status instead of
  // silently keeping stale counts that no longer describe the saved bbox.
  const regionChanged = current.bbox.west !== west || current.bbox.south !== south || current.bbox.east !== east || current.bbox.north !== north
    || (typeof body.countryIso3 === 'string' && body.countryIso3 && body.countryIso3 !== current.countryIso3);
  if (regionChanged && current.villageBuildStatus.status !== 'running') {
    patch.villageBuildStatus = { status: 'idle' };
    // New area == a different fire population entirely; the old area's
    // event/hotspot history has nothing to do with it and must not suppress
    // or seed-skip anything for the new one. See clearFireHistory()'s comment.
    await clearFireHistory();
  }

  const config = await updateConfig(patch);
  return Response.json({ config });
}
