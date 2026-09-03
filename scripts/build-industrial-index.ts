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

// One-time (re-)build of data/industrial-sites.json — the same 7 tags
// lib/landuse.ts used to query live per-detection (landuse=industrial,
// man_made=works, power=plant, power=generator, landuse=quarry,
// man_made=chimney, landuse=landfill), queried ONCE over the whole configured
// bbox and cached to disk. Land use doesn't change, so the running app never
// needs to touch Overpass again — see lib/landuse.ts and README section 5.
//
// The bbox is split into ~1°×1° tiles (about 48 for Algeria's configured
// -2.5,34,9,37.3) and queried one tile at a time, `nwr` (node+way+relation)
// with `out center` — polygons come back as a centroid, not full geometry,
// to keep each request light. Overpass's own bbox order is south,west,north,east
// — the opposite pairing from this project's west,south,east,north convention
// (see scripts/build-villages.ts).
//
// overpass-api.de refuses connections outright from the production VPS; the
// full-planet mirrors (never overpass.osm.ch — regional, see lib/landuse.ts)
// answer but slowly (25-35s observed 2026-09-03), so each tile retries across
// every mirror before giving up, and a 2-3s pause separates tiles regardless
// of outcome. Progress is written to disk after every tile — a killed/crashed
// run resumes from the last completed tile instead of re-querying from tile 0.
//
//   npm run build-industrial-index
import fs from 'node:fs';
import path from 'node:path';
import { distanceKm } from '../lib/geo';
import { displayName } from '../lib/place-name';
import { preferIpv4 } from '../lib/prefer-ipv4';
import { OVERPASS_ENDPOINTS, INDUSTRIAL_TAG_DEFS, industrialTagLabel, type IndustrialSite } from '../lib/landuse';

preferIpv4();

type Bbox = { west: number; south: number; east: number; north: number };
type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number; lon?: number;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  tags?: Record<string, string>;
};
type OverpassResult = { elements: OverpassElement[] };

const TILE_DEG = 1.0;
const PAUSE_BETWEEN_TILES_MS = 2_500;
const PRIMARY_TIMEOUT_MS = 60_000;
const MIRROR_TIMEOUT_MS = 90_000;
const TILE_QUERY_TIMEOUT_S = 120;

const dataDir = path.join(process.cwd(), 'data');
const outPath = path.join(dataDir, 'industrial-sites.json');
const progressPath = path.join(dataDir, '.industrial-index-progress.json');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tilesFor(bbox: Bbox): Bbox[] {
  const tiles: Bbox[] = [];
  for (let s = bbox.south; s < bbox.north; s += TILE_DEG) {
    const n = Math.min(s + TILE_DEG, bbox.north);
    for (let w = bbox.west; w < bbox.east; w += TILE_DEG) {
      const e = Math.min(w + TILE_DEG, bbox.east);
      tiles.push({ west: w, south: s, east: e, north: n });
    }
  }
  return tiles;
}

function tileQuery(tile: Bbox): string {
  const box = `${tile.south},${tile.west},${tile.north},${tile.east}`;
  const clauses = INDUSTRIAL_TAG_DEFS.map(t => `nwr["${t.key}"="${t.value}"](${box});`).join('\n  ');
  return `[out:json][timeout:${TILE_QUERY_TIMEOUT_S}];\n(\n  ${clauses}\n);\nout center;`;
}

// Mirrors are flaky under load (timeouts, 504s) — this is a slow, patient
// batch job with no reader waiting on it, so a tile that exhausts every
// endpoint once is retried in full rounds (with a short backoff) rather than
// failing the whole run. Progress is only lost if every mirror is down for
// MAX_ROUNDS straight — at that point the caller's per-tile checkpoint means
// re-running the script picks up right here anyway.
const MAX_ROUNDS = 8;
const ROUND_BACKOFF_MS = 15_000;

async function queryTile(tile: Bbox, log: (msg: string) => void): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const [index, endpoint] of OVERPASS_ENDPOINTS.entries()) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'User-Agent': 'OzarEye/1.0' },
          body: tileQuery(tile),
          signal: AbortSignal.timeout(index === 0 ? PRIMARY_TIMEOUT_MS : MIRROR_TIMEOUT_MS),
        });
        if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
        const data = await response.json() as OverpassResult;
        return data.elements ?? [];
      } catch (error) {
        lastError = error;
        log(`  tile ${tile.west},${tile.south},${tile.east},${tile.north}: ${new URL(endpoint).host} failed (round ${round}/${MAX_ROUNDS}) — ${error instanceof Error ? error.message : error}`);
      }
    }
    if (round < MAX_ROUNDS) await sleep(ROUND_BACKOFF_MS);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function classify(tags: Record<string, string>): string | null {
  for (const t of INDUSTRIAL_TAG_DEFS) if (tags[t.key] === t.value) return industrialTagLabel(t.key, t.value);
  return null;
}

function toSite(el: OverpassElement): IndustrialSite | null {
  if (!el.tags) return null;
  const tag = classify(el.tags);
  if (!tag) return null;

  const lat = el.type === 'node' ? el.lat : el.center?.lat;
  const lon = el.type === 'node' ? el.lon : el.center?.lon;
  if (lat === undefined || lon === undefined) return null;

  let radius_m: number | null = null;
  if (el.bounds) {
    const diagonalKm = distanceKm(el.bounds.minlat, el.bounds.minlon, el.bounds.maxlat, el.bounds.maxlon);
    radius_m = Math.round((diagonalKm * 1000) / 2);
  }

  const name = el.tags.name ? displayName({ name: el.tags.name, name_ar: el.tags['name:ar'], 'name:fr': el.tags['name:fr'] }) : null;

  return { osm_id: `${el.type}/${el.id}`, type: el.type, tag, name, lat, lon, radius_m };
}

type Progress = { bbox: Bbox; completedTileIndexes: number[]; sitesById: Record<string, IndustrialSite> };

function loadProgress(bbox: Bbox): Progress {
  try {
    const p = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as Progress;
    if (JSON.stringify(p.bbox) === JSON.stringify(bbox)) return p;
    console.log('Progress file is for a different bbox — starting over.');
  } catch {
    // no progress file yet
  }
  return { bbox, completedTileIndexes: [], sitesById: {} };
}

function saveProgress(progress: Progress) {
  const tmp = progressPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(progress));
  fs.renameSync(tmp, progressPath);
}

async function main() {
  const { getConfig, initDb } = await import('../lib/database');
  await initDb();
  const config = await getConfig();
  const bbox = config.bbox;
  const tiles = tilesFor(bbox);

  console.log(`Building industrial-site index over bbox ${bbox.west},${bbox.south},${bbox.east},${bbox.north} (${tiles.length} tiles of ~${TILE_DEG}°).`);

  const progress = loadProgress(bbox);
  const done = new Set(progress.completedTileIndexes);
  if (done.size > 0) console.log(`Resuming: ${done.size}/${tiles.length} tile(s) already completed.`);

  for (let i = 0; i < tiles.length; i++) {
    if (done.has(i)) continue;
    const tile = tiles[i];
    console.log(`Tile ${i + 1}/${tiles.length}: ${tile.west.toFixed(2)},${tile.south.toFixed(2)},${tile.east.toFixed(2)},${tile.north.toFixed(2)}`);
    const elements = await queryTile(tile, msg => console.log(msg));
    let added = 0;
    for (const el of elements) {
      const site = toSite(el);
      if (!site) continue;
      if (!progress.sitesById[site.osm_id]) added++;
      progress.sitesById[site.osm_id] = site;
    }
    console.log(`  -> ${elements.length} element(s), ${added} new site(s) (total ${Object.keys(progress.sitesById).length})`);
    progress.completedTileIndexes.push(i);
    saveProgress(progress);
    await sleep(PAUSE_BETWEEN_TILES_MS);
  }

  const sites = Object.values(progress.sitesById);
  if (sites.length === 0) {
    console.error('Zero industrial sites resolved. Old industrial-sites.json (if any) left untouched.');
    process.exit(1);
  }

  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(sites));
  fs.renameSync(tmpPath, outPath);
  fs.rmSync(progressPath, { force: true });

  const perTag: Record<string, number> = {};
  for (const s of sites) perTag[s.tag] = (perTag[s.tag] ?? 0) + 1;
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);

  console.log(`\nWrote ${sites.length} industrial site(s) to ${outPath} (${sizeKb} KB).`);
  console.log('Per-tag counts:');
  for (const [tag, count] of Object.entries(perTag).sort((a, b) => b[1] - a[1])) console.log(`  ${tag}: ${count}`);
}

main().catch(error => {
  console.error(`\nbuild-industrial-index FAILED: ${error instanceof Error ? error.message : error}`);
  console.error(`Progress saved to ${progressPath} — re-run to resume from the last completed tile.`);
  process.exit(1);
});
