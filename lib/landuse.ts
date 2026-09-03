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

// Primary, then one mirror. The public instance is the right default (it is
// the one whose fair-use policy this query is sized against), but it goes down
// or rate limits often enough that a single failure should not blank out every
// land-use lookup for the whole run — a 2026-09 replay lost all 675 events'
// context to one unreachable host. Tried strictly in order, at most one retry.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

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

  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'User-Agent': 'OzarEye/1.0' },
        body: overpassQuery(lat, lon),
        signal: AbortSignal.timeout(10_000),
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
      return info;
    } catch (error) {
      lastError = error;
      const isLast = endpoint === OVERPASS_ENDPOINTS[OVERPASS_ENDPOINTS.length - 1];
      console.log(`land-use lookup ${isLast ? 'FAILED' : 'failed, trying mirror'} for cell ${cell} via ${new URL(endpoint).host}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (lastError) console.log(`land-use lookup FAILED for cell ${cell}: ${lastError instanceof Error ? lastError.message : lastError}`);
  return { context: 'unknown' };
}

// Test-only: clears the process-lifetime cache between test cases.
export function _clearCacheForTests() { cache.clear(); }
