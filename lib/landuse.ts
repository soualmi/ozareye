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

// Land-use context lookup: tells the engine WHAT sits under a detection, so a
// permanent industrial/energy heat source (a steel plant, a gas flare, a
// quarry, a landfill) isn't presented to a reader as a probable wildfire —
// the incident that prompted this was a detection landing exactly on
// Complexe Sidérurgique de Bellara.
//
// This is immediate, first-detection context — it complements, not
// replaces, the 30-day persistent-source guard in app/api/monitor/route.ts,
// which has no way to know about a site in advance and instead catches
// unnamed recurring sources purely from their detection history over time.
//
// Land use doesn't change, so the default path is a LOCAL lookup against
// data/industrial-sites.json — built once, offline, by
// scripts/build-industrial-index.ts (see README) — instead of a live
// Overpass query on every detection. overpass-api.de refuses connections
// from the production VPS entirely and the full-planet mirrors answer in
// 25-35s each, which made land-use effectively off in prod; a local index
// resolves in well under a millisecond and has no network dependency at all.
//
// Overpass is kept as an explicit FALLBACK, used only when the index file is
// missing or unreadable (e.g. a fresh clone that hasn't run the build script
// yet) — same breaker/mirror logic as before, so that path still fails soft.
import fs from 'node:fs';
import path from 'node:path';
import { distanceKm } from './geo';
import { gridCell } from './fire-monitor';
import { preferIpv4 } from './prefer-ipv4';
import type { LandUseContext, LandUseInfo } from './fire-monitor';

export type { LandUseContext, LandUseInfo };

// A site this close to a detection (plus its own footprint, see radius_m
// below) counts as a hit — same 1km figure the old per-point Overpass query
// used as its search radius.
const RADIUS_M = 1000;

// ---------------------------------------------------------------------------
// Local index lookup (the default path)
// ---------------------------------------------------------------------------

export type Bounds = { minlat: number; minlon: number; maxlat: number; maxlon: number };

export type IndustrialSite = {
  osm_id: string;
  type: 'node' | 'way' | 'relation';
  tag: string; // e.g. "landuse=industrial" — which of the 7 tags matched
  name: string | null; // displayName() already applied at build time — never Tifinagh
  lat: number; // centre — the midpoint of `bounds` when present (verified
  // numerically against Overpass's own `out center`: they're identical), or
  // the node's own coordinate.
  lon: number;
  /** Real footprint for a way/relation (Overpass `out bb`) — null for nodes,
   *  a point has no footprint. A detection landing anywhere inside this
   *  rectangle is a hit, however far from `lat`/`lon` the rectangle is wide. */
  bounds: Bounds | null;
  /** Half the bounds diagonal, in metres — null for nodes. Used as the extra
   *  reach beyond RADIUS_M around the centre; also always ≥ the true max
   *  distance from centre to any point inside bounds, since a half-diagonal
   *  is exactly that for an axis-aligned rectangle. */
  radius_m: number | null;
};

// Overridable so tests can point at a throwaway (or deliberately missing)
// file instead of the real shipped index — same pattern as
// ALGERIE_FEUX_DB_PATH in lib/db/sqlite.ts.
function indexPath(): string {
  return process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH || path.join(process.cwd(), 'data', 'industrial-sites.json');
}

// Grid bucket: ~0.1° cells (~11km), keyed by every cell a site's footprint
// (bounds, or just its point for a node) plus RADIUS_M + its own radius_m
// overlaps — so a big site (a petrochemical zone spanning several km) is
// found from ANY cell it covers, not only the one its centre falls in. Using
// deliberately conservative (smaller-than-true) metres-per-degree constants
// means the computed degree buffer always OVER-estimates the real distance,
// so a cell is never missed — only, at worst, checked for a candidate that
// then fails the precise distance/bounds test in lookupLocal() below.
const CELL_DEG = 0.1;
// Real values for this bbox's latitude range (34-37.3°N) are ~110,574-110,649
// m/deg latitude (effectively constant) and ~88,500-92,300 m/deg longitude
// (shrinks going north) — both constants below are picked below the true
// minimum so the degree buffer they produce is always an over-estimate.
const LAT_M_PER_DEG = 110_000;
const LON_M_PER_DEG = 85_000;

function cellIndex(deg: number): number {
  return Math.floor(deg / CELL_DEG);
}
function cellKey(latIdx: number, lonIdx: number): string {
  return `${latIdx},${lonIdx}`;
}

function siteFootprint(site: IndustrialSite): Bounds {
  const extraM = RADIUS_M + (site.radius_m ?? 0);
  const extraLat = extraM / LAT_M_PER_DEG;
  const extraLon = extraM / LON_M_PER_DEG;
  if (site.bounds) {
    return { minlat: site.bounds.minlat - extraLat, maxlat: site.bounds.maxlat + extraLat, minlon: site.bounds.minlon - extraLon, maxlon: site.bounds.maxlon + extraLon };
  }
  return { minlat: site.lat - extraLat, maxlat: site.lat + extraLat, minlon: site.lon - extraLon, maxlon: site.lon + extraLon };
}

type Buckets = Map<string, IndustrialSite[]>;

function buildBuckets(sites: IndustrialSite[]): Buckets {
  const buckets: Buckets = new Map();
  for (const site of sites) {
    const fp = siteFootprint(site);
    const latFrom = cellIndex(fp.minlat), latTo = cellIndex(fp.maxlat);
    const lonFrom = cellIndex(fp.minlon), lonTo = cellIndex(fp.maxlon);
    for (let i = latFrom; i <= latTo; i++) {
      for (let j = lonFrom; j <= lonTo; j++) {
        const key = cellKey(i, j);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(site); else buckets.set(key, [site]);
      }
    }
  }
  return buckets;
}

function pointInBounds(lat: number, lon: number, b: Bounds): boolean {
  return lat >= b.minlat && lat <= b.maxlat && lon >= b.minlon && lon <= b.maxlon;
}

// undefined = not loaded yet; null = load failed (missing/unreadable) and
// Overpass is the fallback for the rest of the process lifetime.
let bucketsCache: Buckets | null | undefined;

function loadIndex(): Buckets | null {
  if (bucketsCache !== undefined) return bucketsCache;
  try {
    const sites = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as IndustrialSite[];
    bucketsCache = buildBuckets(sites);
  } catch {
    bucketsCache = null;
  }
  return bucketsCache;
}

// A hit is either INSIDE a site's real footprint (bounds), however far that
// is from its centre point, OR within RADIUS_M of the centre plus the site's
// own radius_m — the second clause is what covers a node (no bounds at all)
// and is a superset of "inside bounds" for any site with a computed
// radius_m, but both are checked explicitly rather than relying on that
// implication holding for every future edge case.
function lookupLocal(buckets: Buckets, lat: number, lon: number): LandUseInfo {
  const bucket = buckets.get(cellKey(cellIndex(lat), cellIndex(lon)));
  if (!bucket) return { context: 'natural' };

  let best: { site: IndustrialSite; inside: boolean; distanceM: number } | null = null;
  const seen = new Set<string>();
  for (const site of bucket) {
    if (seen.has(site.osm_id)) continue; // a site can appear in >1 cell
    seen.add(site.osm_id);
    const inside = site.bounds ? pointInBounds(lat, lon, site.bounds) : false;
    const distanceM = distanceKm(lat, lon, site.lat, site.lon) * 1000;
    const withinReach = distanceM <= RADIUS_M + (site.radius_m ?? 0);
    if (!inside && !withinReach) continue;
    // Prefer an "inside bounds" hit over a merely-nearby one; among ties, the closest centre.
    if (!best || (inside && !best.inside) || (inside === best.inside && distanceM < best.distanceM)) {
      best = { site, inside, distanceM };
    }
  }
  if (!best) return { context: 'natural' };
  return { context: 'industrial', siteName: best.site.name ?? undefined };
}

// ---------------------------------------------------------------------------
// Overpass fallback (only reached when the local index is absent/unreadable)
// ---------------------------------------------------------------------------

// Tried strictly in order until one answers. The canonical instance stays the
// default — it is the one this query's size is polite against — but a single
// unreachable host must not blank out land-use for a whole run: a 2026-09
// replay lost all 675 events' context that way.
//
// ONLY FULL-PLANET INSTANCES BELONG HERE. A regional extract answers 200 with
// an empty element list for anywhere outside its region, which this code reads
// as "no industrial site nearby" — a silent false negative, strictly worse
// than a failure. overpass.osm.ch looked like an ideal mirror on 2026-09-03
// (0.16s, healthy) and is Switzerland-only: it reported Bellara and the El
// Hamma power plant as 'natural'. Verify any new entry with a query over the
// target region before adding it. Also used by scripts/build-industrial-index.ts
// to build the local index in the first place.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// The primary answers healthy queries in about a second, so a short bound
// there fails fast off a hung host. The mirrors are the degraded path and are
// routinely loaded (30s+ on 2026-09-03) — waiting is better than losing the
// context, since nothing downstream blocks on this.
const PRIMARY_TIMEOUT_MS = 10_000;
const MIRROR_TIMEOUT_MS = 25_000;

// Circuit breaker. Land-use is best-effort context; alerts must never wait on
// it. During the 2026-09-03 outage every endpoint failed and a lookup cost ~60s
// of timeouts, so a single monitor run over ~50 events would have spent most of
// an hour in here and delayed the alerts it exists to annotate. After a couple
// of consecutive failures the whole feature goes quiet for a cooldown and
// returns 'unknown' with no network call at all; the next run tries again. One
// success anywhere resets it.
const BREAKER_FAILURE_THRESHOLD = 2;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let consecutiveFailures = 0;
let breakerOpenedAt = 0;

function breakerOpen(now: number): boolean {
  if (!breakerOpenedAt) return false;
  if (now - breakerOpenedAt < BREAKER_COOLDOWN_MS) return true;
  breakerOpenedAt = 0;
  consecutiveFailures = 0;
  return false;
}

// Tags that mark a probable non-wildfire, permanent heat-producing or
// non-vegetation site. Not exhaustive — this is a coarse first-detection
// filter, not a land-registry survey. Exported as structured defs so
// scripts/build-industrial-index.ts can build its own bbox query and classify
// results from the exact same list instead of a second copy.
export const INDUSTRIAL_TAG_DEFS: { key: string; value: string }[] = [
  { key: 'landuse', value: 'industrial' },
  { key: 'man_made', value: 'works' },
  { key: 'power', value: 'plant' },
  { key: 'power', value: 'generator' },
  { key: 'landuse', value: 'quarry' },
  { key: 'man_made', value: 'chimney' },
  { key: 'landuse', value: 'landfill' },
];

export function industrialTagLabel(key: string, value: string): string {
  return `${key}=${value}`;
}

const INDUSTRIAL_TAGS = INDUSTRIAL_TAG_DEFS.map(t => `["${t.key}"="${t.value}"]`);

// One process-lifetime cache entry per ~1km cell (same rounding as the
// persistent-source guard's gridCell in lib/fire-monitor.ts) — a site like
// Bellara gets queried once, not once per repeat detection. Only successful
// lookups are cached; a failure is left uncached so the next poll retries
// instead of an event sticking as 'unknown' forever because of one bad
// network blip. Only used on the Overpass fallback path — the local index
// above needs no cache, it's already well under a millisecond per lookup.
const cache = new Map<string, LandUseInfo>();

function overpassQuery(lat: number, lon: number): string {
  const clauses = INDUSTRIAL_TAGS.map(tag => `nwr(around:${RADIUS_M},${lat},${lon})${tag};`).join('\n  ');
  return `[out:json][timeout:10];\n(\n  ${clauses}\n);\nout center 5 tags;`;
}

type OverpassElement = { tags?: Record<string, string> };
type OverpassResponse = { elements?: OverpassElement[] };

async function lookupLandUseOverpass(lat: number, lon: number): Promise<LandUseInfo> {
  preferIpv4();
  const cell = gridCell(lat, lon);
  const cached = cache.get(cell);
  if (cached) return cached;
  if (breakerOpen(Date.now())) return { context: 'unknown' };

  let lastError: unknown;
  for (const [index, endpoint] of OVERPASS_ENDPOINTS.entries()) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'User-Agent': 'OzarEye/1.0' },
        body: overpassQuery(lat, lon),
        signal: AbortSignal.timeout(index === 0 ? PRIMARY_TIMEOUT_MS : MIRROR_TIMEOUT_MS),
      });
      // 429 and 5xx are the endpoint's problem, not the query's — worth asking
      // the mirror. A 4xx other than 429 would fail identically there, so it
      // ends the attempt rather than doubling the load.
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); break; }
      const data = await response.json() as OverpassResponse;
      const elements = data.elements ?? [];
      const named = elements.find(e => e.tags?.name);
      const info: LandUseInfo = elements.length ? { context: 'industrial', siteName: named?.tags?.name } : { context: 'natural' };
      cache.set(cell, info);
      consecutiveFailures = 0;
      return info;
    } catch (error) {
      lastError = error;
      const isLast = endpoint === OVERPASS_ENDPOINTS[OVERPASS_ENDPOINTS.length - 1];
      console.log(`land-use lookup ${isLast ? 'FAILED' : 'failed, trying mirror'} for cell ${cell} via ${new URL(endpoint).host}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (lastError) console.log(`land-use lookup FAILED for cell ${cell}: ${lastError instanceof Error ? lastError.message : lastError}`);
  if (++consecutiveFailures >= BREAKER_FAILURE_THRESHOLD && !breakerOpenedAt) {
    breakerOpenedAt = Date.now();
    console.log(`land-use: ${consecutiveFailures} consecutive failures — pausing lookups for ${BREAKER_COOLDOWN_MS / 60_000}min so alerts aren't held up`);
  }
  return { context: 'unknown' };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function lookupLandUse(lat: number, lon: number): Promise<LandUseInfo> {
  const buckets = loadIndex();
  if (buckets) return lookupLocal(buckets, lat, lon);
  return lookupLandUseOverpass(lat, lon);
}

// Test-only: clears the process-lifetime caches (Overpass cache/breaker AND
// the loaded index, so a test that changes ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH
// actually reloads from the new path) between test cases.
export function _clearCacheForTests() {
  cache.clear();
  consecutiveFailures = 0;
  breakerOpenedAt = 0;
  bucketsCache = undefined;
}
