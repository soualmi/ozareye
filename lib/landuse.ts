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

// Land-use context lookup (OpenStreetMap/Overpass): tells the engine WHAT
// sits under a detection, so a permanent industrial/energy heat source (a
// steel plant, a gas flare, a quarry, a landfill) isn't presented to a
// reader as a probable wildfire — the incident that prompted this was a
// detection landing exactly on Complexe Sidérurgique de Bellara.
//
// This is immediate, first-detection context — it complements, not
// replaces, the 30-day persistent-source guard in app/api/monitor/route.ts,
// which has no way to know about a site in advance and instead catches
// unnamed recurring sources purely from their detection history over time.
//
// Fails soft by design: any Overpass error or timeout returns context
// 'unknown' and the event proceeds exactly as it did before this feature
// existed — never blocked, never dropped.
import { gridCell } from './fire-monitor';
import { preferIpv4 } from './prefer-ipv4';
import type { LandUseContext, LandUseInfo } from './fire-monitor';

export type { LandUseContext, LandUseInfo };

const RADIUS_M = 1000;

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
// target region before adding it.
const OVERPASS_ENDPOINTS = [
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
// filter, not a land-registry survey.
const INDUSTRIAL_TAGS = [
  '["landuse"="industrial"]',
  '["man_made"="works"]',
  '["power"="plant"]',
  '["power"="generator"]',
  '["landuse"="quarry"]',
  '["man_made"="chimney"]',
  '["landuse"="landfill"]',
];

// One process-lifetime cache entry per ~1km cell (same rounding as the
// persistent-source guard's gridCell in lib/fire-monitor.ts) — a site like
// Bellara gets queried once, not once per repeat detection. Only successful
// lookups are cached; a failure is left uncached so the next poll retries
// instead of an event sticking as 'unknown' forever because of one bad
// network blip.
const cache = new Map<string, LandUseInfo>();

function overpassQuery(lat: number, lon: number): string {
  const clauses = INDUSTRIAL_TAGS.map(tag => `nwr(around:${RADIUS_M},${lat},${lon})${tag};`).join('\n  ');
  return `[out:json][timeout:10];\n(\n  ${clauses}\n);\nout center 5 tags;`;
}

type OverpassElement = { tags?: Record<string, string> };
type OverpassResponse = { elements?: OverpassElement[] };

export async function lookupLandUse(lat: number, lon: number): Promise<LandUseInfo> {
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

// Test-only: clears the process-lifetime cache between test cases.
export function _clearCacheForTests() { cache.clear(); consecutiveFailures = 0; breakerOpenedAt = 0; }
