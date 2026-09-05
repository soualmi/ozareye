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

// Forest-cover lookup: tells the engine WHETHER a detection sits inside a
// real, OSM-tagged forest polygon — the honest counterpart to the earlier
// village-type approximation used in an ad-hoc analysis ("isolé" = far from
// a city/town). There is no real land-cover/vegetation dataset in this
// codebase otherwise: this index is exactly as good as OSM's own
// landuse=forest / natural=wood tagging in Algeria, no better — it is not a
// satellite-derived vegetation survey.
//
// Same pattern as lib/landuse.ts's industrial-site index, built two days
// earlier: a ONE-TIME offline build (scripts/build-forest-index.ts) writes
// data/forest-areas.json, and this module does a local, offline, sub-
// millisecond lookup against it. Unlike lib/landuse.ts there is no live
// Overpass fallback here — forest context is a nice-to-have signal, not
// something worth a 25-35s network round trip per detection for. A missing
// or unreadable index simply means "not known to be forest" (false), never
// a fabricated answer either way.
import fs from 'node:fs';
import path from 'node:path';
import { distanceKm } from './geo';

export type Bounds = { minlat: number; minlon: number; maxlat: number; maxlon: number };

export type ForestArea = {
  osm_id: string;
  type: 'node' | 'way' | 'relation';
  tag: string; // "landuse=forest" or "natural=wood"
  name: string | null; // displayName() already applied at build time — never Tifinagh
  lat: number; // centre — the midpoint of `bounds` when present, or the node's own coordinate
  lon: number;
  /** Real footprint for a way/relation (Overpass `out bb`) — null for nodes. */
  bounds: Bounds | null;
  /** Half the bounds diagonal, in metres — null for nodes. */
  radius_m: number | null;
};

// A point this close to a forest polygon's edge (plus the polygon's own
// radius_m, for the "near centroid" fallback a node-only tag needs) still
// counts as forest-adjacent — same 1km figure lib/landuse.ts uses for the
// same reason (a detection a few hundred metres from a forest boundary is
// still, honestly, a forest-edge fire).
const RADIUS_M = 1000;

// Tags that mark OSM-surveyed forest cover. Not exhaustive (no
// natural=scrub, no leaf_type detail) — this is a coarse, honest signal
// from what OSM actually tags, not a vegetation survey. Exported so
// scripts/build-forest-index.ts builds its own bbox query and classifies
// results from the exact same list instead of a second copy.
export const FOREST_TAG_DEFS: { key: string; value: string }[] = [
  { key: 'landuse', value: 'forest' },
  { key: 'natural', value: 'wood' },
];

export function forestTagLabel(key: string, value: string): string {
  return `${key}=${value}`;
}

// Overridable so tests can point at a throwaway (or deliberately missing)
// file instead of the real shipped index — same pattern as
// ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH in lib/landuse.ts.
function indexPath(): string {
  return process.env.ALGERIE_FEUX_FOREST_INDEX_PATH || path.join(process.cwd(), 'data', 'forest-areas.json');
}

// Same ~0.1° (~11km) grid-bucket spatial index as lib/landuse.ts, same
// deliberately conservative (smaller-than-true) metres-per-degree constants
// so the computed degree buffer always over-estimates the real distance —
// a cell is never missed, only, at worst, checked for a candidate that then
// fails the precise distance/bounds test in lookupLocal() below. Forest
// polygons are typically much LARGER than an industrial site, so a single
// forest can (correctly) populate many cells.
const CELL_DEG = 0.1;
const LAT_M_PER_DEG = 110_000;
const LON_M_PER_DEG = 85_000;

function cellIndex(deg: number): number {
  return Math.floor(deg / CELL_DEG);
}
function cellKey(latIdx: number, lonIdx: number): string {
  return `${latIdx},${lonIdx}`;
}

function areaFootprint(area: ForestArea): Bounds {
  const extraM = RADIUS_M + (area.radius_m ?? 0);
  const extraLat = extraM / LAT_M_PER_DEG;
  const extraLon = extraM / LON_M_PER_DEG;
  if (area.bounds) {
    return { minlat: area.bounds.minlat - extraLat, maxlat: area.bounds.maxlat + extraLat, minlon: area.bounds.minlon - extraLon, maxlon: area.bounds.maxlon + extraLon };
  }
  return { minlat: area.lat - extraLat, maxlat: area.lat + extraLat, minlon: area.lon - extraLon, maxlon: area.lon + extraLon };
}

type Buckets = Map<string, ForestArea[]>;

function buildBuckets(areas: ForestArea[]): Buckets {
  const buckets: Buckets = new Map();
  for (const area of areas) {
    const fp = areaFootprint(area);
    const latFrom = cellIndex(fp.minlat), latTo = cellIndex(fp.maxlat);
    const lonFrom = cellIndex(fp.minlon), lonTo = cellIndex(fp.maxlon);
    for (let i = latFrom; i <= latTo; i++) {
      for (let j = lonFrom; j <= lonTo; j++) {
        const key = cellKey(i, j);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(area); else buckets.set(key, [area]);
      }
    }
  }
  return buckets;
}

function pointInBounds(lat: number, lon: number, b: Bounds): boolean {
  return lat >= b.minlat && lat <= b.maxlat && lon >= b.minlon && lon <= b.maxlon;
}

// undefined = not loaded yet; null = load failed (missing/unreadable) —
// isInForest() then always returns false, same fail-soft shape as
// lib/landuse.ts's Overpass fallback returning 'unknown'.
let bucketsCache: Buckets | null | undefined;

function loadIndex(): Buckets | null {
  if (bucketsCache !== undefined) return bucketsCache;
  try {
    const areas = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as ForestArea[];
    bucketsCache = buildBuckets(areas);
  } catch {
    bucketsCache = null;
  }
  return bucketsCache;
}

// Same "inside real footprint (any distance from centre), OR within
// RADIUS_M of centre plus the area's own radius_m" hit logic as
// lib/landuse.ts's lookupLocal — a point-only match here needs no "which
// site" tie-break since the answer is a plain boolean, not a name.
function lookupLocal(buckets: Buckets, lat: number, lon: number): boolean {
  const bucket = buckets.get(cellKey(cellIndex(lat), cellIndex(lon)));
  if (!bucket) return false;
  for (const area of bucket) {
    const inside = area.bounds ? pointInBounds(lat, lon, area.bounds) : false;
    if (inside) return true;
    const distanceM = distanceKm(lat, lon, area.lat, area.lon) * 1000;
    if (distanceM <= RADIUS_M + (area.radius_m ?? 0)) return true;
  }
  return false;
}

// Public entry point. Fail-soft by construction: a missing/unreadable index
// makes loadIndex() return null, which this turns into `false` — never
// throws, never blocks the caller, never fabricates a state.
export function isInForest(lat: number, lon: number): boolean {
  const buckets = loadIndex();
  if (!buckets) return false;
  return lookupLocal(buckets, lat, lon);
}

// Test-only: clears the loaded-index cache so a test that changes
// ALGERIE_FEUX_FOREST_INDEX_PATH actually reloads from the new path — same
// pattern as lib/landuse.ts's _clearCacheForTests().
export function _clearForestCacheForTests() {
  bucketsCache = undefined;
}
