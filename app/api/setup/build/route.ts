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

import path from 'node:path';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { getConfig, initDb, updateConfig, type EngineConfig } from '@/lib/database';
import { buildAdminBoundaries } from '@/lib/admin-boundaries';
import { buildVillages } from '@/scripts/build-villages';
import { invalidateWilayaCache } from '@/lib/wilaya';

// Above this rough area, a single Overpass query is likely to be slow or
// time out — not a hard limit, just what /setup warns about and asks the
// user to confirm before running. Well above the shipped Algeria default's
// bbox (~380,000km², the northern belt only) so the existing instance never
// trips it on an unchanged region.
const LARGE_AREA_WARNING_KM2 = 2_000_000;

function approxAreaKm2(bbox: EngineConfig['bbox']): number {
  const avgLatRad = ((bbox.south + bbox.north) / 2) * Math.PI / 180;
  const kmPerDegLat = 111.32;
  const kmPerDegLon = 111.32 * Math.cos(avgLatRad);
  return Math.abs(bbox.east - bbox.west) * kmPerDegLon * Math.abs(bbox.north - bbox.south) * kmPerDegLat;
}

// Guards against two overlapping build requests in this same process — the
// DB status is the source of truth across restarts, this just avoids a
// double-click firing two Overpass queries at once within one running server.
let buildInFlight = false;

async function runBuild(config: EngineConfig) {
  const startedAt = new Date().toISOString();
  buildInFlight = true;
  try {
    const villagesPath = path.join(process.cwd(), 'data', 'villages.json');
    const wilayasPath = path.join(process.cwd(), 'data', 'wilayas.geojson');

    await updateConfig({ villageBuildStatus: { status: 'running', startedAt, step: 'Frontières administratives…' } });
    const adminResult = await buildAdminBoundaries(config.countryIso3, wilayasPath, step =>
      updateConfig({ villageBuildStatus: { status: 'running', startedAt, step } }));
    // The just-written boundaries file must be re-read, not served from the
    // previous country's cached shapes — see lib/wilaya.ts invalidateWilayaCache().
    invalidateWilayaCache();

    await updateConfig({ villageBuildStatus: { status: 'running', startedAt, step: 'Villages…' } });
    const villageResult = await buildVillages(config.bbox, villagesPath, step =>
      updateConfig({ villageBuildStatus: { status: 'running', startedAt, step } }));

    await updateConfig({
      configured: true,
      villageBuildStatus: {
        status: 'success', startedAt, finishedAt: new Date().toISOString(),
        villageCount: villageResult.count, perRegion: villageResult.perRegion, droppedOutsideBoundary: villageResult.droppedOutsideBoundary,
        adminBoundariesOk: adminResult.ok, adminBoundariesError: adminResult.ok ? undefined : adminResult.error,
      },
    });
  } catch (error) {
    // buildVillages only replaces data/villages.json on success (atomic
    // tmp+rename) — a thrown error here means the previous, working index is
    // still exactly as it was. `configured` is untouched, so the instance
    // keeps running on its last good data while this failure is surfaced.
    await updateConfig({
      villageBuildStatus: { status: 'error', startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    buildInFlight = false;
  }
}

// Starts the region build as a background job and returns immediately —
// the client polls GET for progress instead of holding the connection open
// for what can be a multi-minute Overpass query.
export async function POST(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  if (buildInFlight) return Response.json({ error: 'Une génération est déjà en cours.' }, { status: 409 });

  let body: { confirmed?: unknown } = {};
  try { body = await request.json() as { confirmed?: unknown }; } catch { /* empty body is fine */ }

  await initDb();
  const config = await getConfig();
  const areaKm2 = approxAreaKm2(config.bbox);
  if (areaKm2 > LARGE_AREA_WARNING_KM2 && body.confirmed !== true) {
    return Response.json({
      warning: `Cette zone est très grande (environ ${Math.round(areaKm2).toLocaleString('fr-FR')} km²) : la requête Overpass risque d'être lente ou d'échouer. Confirmer pour lancer quand même ?`,
      areaKm2,
    }, { status: 409 });
  }

  void runBuild(config);
  return Response.json({ started: true });
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  await initDb();
  const config = await getConfig();
  return Response.json({ villageBuildStatus: config.villageBuildStatus });
}
