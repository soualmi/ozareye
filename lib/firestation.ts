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

// Nearest fire station (caserne de la Protection Civile) to a point, from
// the local data/fire-stations.json index built once offline by
// scripts/build-firestation-index.ts — the same "extract once, never query
// Overpass at request time" pattern as lib/landuse.ts. The index is small
// (a few hundred stations for Algeria's bbox as of 2026-09), so a plain
// haversine scan over every entry is the whole algorithm — no grid bucket,
// no k-d tree. Revisit if a region ever ships thousands of stations.
//
// Fail-soft by construction: a missing or unreadable index resolves to null
// and every caller treats null as "no station line" — nothing (alerts,
// dashboard, Telegram) ever blocks on this.
import fs from 'node:fs';
import path from 'node:path';
import { distanceKm } from './geo';

export type FireStation = {
  osm_id: string;
  /** displayName() already applied at build time (Tifinagh stripped); null when OSM has no name. */
  name: string | null;
  lat: number;
  lon: number;
  /** OSM `phone`/`contact:phone`, verbatim — null when absent. NEVER invented. */
  phone: string | null;
};

export type NearestFireStation = FireStation & { distanceKm: number };

// Overridable so tests can point at a throwaway (or deliberately missing)
// file — same pattern as ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH in lib/landuse.ts.
function indexPath(): string {
  return process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH || path.join(process.cwd(), 'data', 'fire-stations.json');
}

// undefined = not loaded yet; null = load failed for this process lifetime.
let stationsCache: FireStation[] | null | undefined;

function loadIndex(): FireStation[] | null {
  if (stationsCache !== undefined) return stationsCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as unknown;
    stationsCache = Array.isArray(parsed) ? (parsed as FireStation[]).filter(s => typeof s?.lat === 'number' && typeof s?.lon === 'number') : null;
    if (stationsCache && stationsCache.length === 0) stationsCache = null;
  } catch {
    stationsCache = null;
  }
  return stationsCache;
}

export function fireStationCount(): number {
  return loadIndex()?.length ?? 0;
}

export function nearestFireStation(lat: number, lon: number): NearestFireStation | null {
  const stations = loadIndex();
  if (!stations) return null;
  let best: NearestFireStation | null = null;
  for (const station of stations) {
    const d = distanceKm(lat, lon, station.lat, station.lon);
    if (!best || d < best.distanceKm) best = { ...station, distanceKm: d };
  }
  return best;
}

// The one display string every surface (list card, popup, detail, Telegram)
// renders for the nearest station — one template, so the wording never
// drifts between them. An unnamed OSM station still gets a line: the
// reader needs the distance, not the name.
export function nearestStationLine(station: NearestFireStation | null): string | undefined {
  if (!station) return undefined;
  const km = `${station.distanceKm.toFixed(1)} km`;
  return station.name ? `Caserne la plus proche : ${station.name} — ${km}` : `Caserne la plus proche (sans nom sur OSM) — ${km}`;
}

export function _clearCacheForTests() {
  stationsCache = undefined;
}
