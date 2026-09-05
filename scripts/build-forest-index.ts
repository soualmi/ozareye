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

// One-time (re-)build of data/forest-areas.json — real OSM forest cover
// (landuse=forest, natural=wood), queried ONCE over the whole configured
// bbox and cached to disk. Same tile-walk/mirror/footprint pattern as
// scripts/build-industrial-index.ts (built two days earlier) — see that
// script's header comment for the full rationale behind every choice below;
// this is a mechanical mirror of it for a different pair of tags, not a
// redesign. Never invent boundaries: only what OSM actually tags is
// extracted, at whatever real footprint it has.
//
// The bbox is split into ~1°×1° tiles (about 48 for Algeria's configured
// -2.5,34,9,37.3) and queried one tile at a time, `nwr` (node+way+relation)
// with `out bb` — real bounds for a way/relation, lat/lon directly for a
// node. Forest polygons are typically large, so bounds-aware matching (not
// a centroid-only point) is what makes this index actually useful — a fire
// near the edge of a big forest polygon must still resolve as "in forest".
//
//   npm run build-forest-index
import fs from 'node:fs';
import path from 'node:path';
import { distanceKm } from '../lib/geo';
import { displayName } from '../lib/place-name';
import { preferIpv4 } from '../lib/prefer-ipv4';
import { OVERPASS_ENDPOINTS } from '../lib/landuse';
import { FOREST_TAG_DEFS, forestTagLabel, type ForestArea, type Bounds } from '../lib/forestcover';

preferIpv4();

type Bbox = { west: number; south: number; east: number; north: number };
type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number; lon?: number; // nodes only, from `out bb`
  bounds?: Bounds; // ways/relations only, from `out bb`
  tags?: Record<string, string>;
};
type OverpassResult = { elements: OverpassElement[] };

const TILE_DEG = 1.0;
const PAUSE_BETWEEN_TILES_MS = 2_500;
const PRIMARY_TIMEOUT_MS = 60_000;
const MIRROR_TIMEOUT_MS = 90_000;
const TILE_QUERY_TIMEOUT_S = 120;

const dataDir = path.join(process.cwd(), 'data');
const outPath = path.join(dataDir, 'forest-areas.json');
const progressPath = path.join(dataDir, '.forest-index-progress.json');

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
  const clauses = FOREST_TAG_DEFS.map(t => `nwr["${t.key}"="${t.value}"](${box});`).join('\n  ');
  return `[out:json][timeout:${TILE_QUERY_TIMEOUT_S}];\n(\n  ${clauses}\n);\nout bb;`;
}

// Same patient full-round retry as the industrial index build — this is a
// slow batch job with no reader waiting on it.
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
  for (const t of FOREST_TAG_DEFS) if (tags[t.key] === t.value) return forestTagLabel(t.key, t.value);
  return null;
}

function toArea(el: OverpassElement): ForestArea | null {
  if (!el.tags) return null;
  const tag = classify(el.tags);
  if (!tag) return null;

  let lat: number, lon: number, bounds: Bounds | null = null, radius_m: number | null = null;
  if (el.type === 'node') {
    if (el.lat === undefined || el.lon === undefined) return null;
    lat = el.lat; lon = el.lon;
  } else {
    if (!el.bounds) return null; // no footprint at all — drop rather than guess
    bounds = el.bounds;
    lat = (el.bounds.minlat + el.bounds.maxlat) / 2;
    lon = (el.bounds.minlon + el.bounds.maxlon) / 2;
    const diagonalKm = distanceKm(el.bounds.minlat, el.bounds.minlon, el.bounds.maxlat, el.bounds.maxlon);
    radius_m = Math.round((diagonalKm * 1000) / 2);
  }

  const name = el.tags.name ? displayName({ name: el.tags.name, name_ar: el.tags['name:ar'], 'name:fr': el.tags['name:fr'] }) : null;

  return { osm_id: `${el.type}/${el.id}`, type: el.type, tag, name, lat, lon, bounds, radius_m };
}

type Progress = { bbox: Bbox; completedTileIndexes: number[]; areasById: Record<string, ForestArea> };

function loadProgress(bbox: Bbox): Progress {
  try {
    const p = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as Progress;
    if (JSON.stringify(p.bbox) === JSON.stringify(bbox)) return p;
    console.log('Progress file is for a different bbox — starting over.');
  } catch {
    // no progress file yet
  }
  return { bbox, completedTileIndexes: [], areasById: {} };
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

  console.log(`Building forest-cover index over bbox ${bbox.west},${bbox.south},${bbox.east},${bbox.north} (${tiles.length} tiles of ~${TILE_DEG}°).`);

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
      const area = toArea(el);
      if (!area) continue;
      if (!progress.areasById[area.osm_id]) added++;
      progress.areasById[area.osm_id] = area;
    }
    console.log(`  -> ${elements.length} element(s), ${added} new area(s) (total ${Object.keys(progress.areasById).length})`);
    progress.completedTileIndexes.push(i);
    saveProgress(progress);
    await sleep(PAUSE_BETWEEN_TILES_MS);
  }

  const areas = Object.values(progress.areasById);
  if (areas.length === 0) {
    console.error('Zero forest areas resolved. Old forest-areas.json (if any) left untouched.');
    process.exit(1);
  }

  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(areas));
  fs.renameSync(tmpPath, outPath);
  fs.rmSync(progressPath, { force: true });

  const perTag: Record<string, number> = {};
  for (const a of areas) perTag[a.tag] = (perTag[a.tag] ?? 0) + 1;
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);

  const withBounds = areas.filter(a => a.bounds !== null);
  // Rough total covered area: sum of each polygon's bounding-box area — an
  // over-estimate for any non-rectangular forest (most of them), reported
  // as exactly that, not a precise land-cover survey figure.
  const totalBboxKm2 = withBounds.reduce((sum, a) => {
    const b = a.bounds!;
    const widthKm = distanceKm(b.minlat, b.minlon, b.minlat, b.maxlon);
    const heightKm = distanceKm(b.minlat, b.minlon, b.maxlat, b.minlon);
    return sum + widthKm * heightKm;
  }, 0);

  console.log(`\nWrote ${areas.length} forest area(s) to ${outPath} (${sizeKb} KB).`);
  console.log(`${withBounds.length} of ${areas.length} have real bounds (ways/relations); ${areas.length - withBounds.length} are nodes (point only).`);
  console.log(`Approximate total bounding-box area of all polygons: ${totalBboxKm2.toFixed(0)} km² (an OVER-estimate for non-rectangular forests — not a precise coverage figure).`);
  console.log('Per-tag counts:');
  for (const [tag, count] of Object.entries(perTag).sort((a, b) => b[1] - a[1])) console.log(`  ${tag}: ${count}`);

  const largest = areas.filter(a => a.radius_m !== null).sort((a, b) => b.radius_m! - a.radius_m!).slice(0, 10);
  console.log('\nLargest 10 areas by radius_m:');
  for (const a of largest) console.log(`  ${a.radius_m}m — ${a.name ?? '(unnamed)'} (${a.osm_id})`);
}

main().catch(error => {
  console.error(`\nbuild-forest-index FAILED: ${error instanceof Error ? error.message : error}`);
  console.error(`Progress saved to ${progressPath} — re-run to resume from the last completed tile.`);
  process.exit(1);
});
