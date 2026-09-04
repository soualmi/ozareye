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

// One-time (re-)build of data/fire-stations.json — every OSM
// amenity=fire_station (node, way or relation) inside the configured bbox,
// queried ONCE and cached to disk so lib/firestation.ts can answer "nearest
// caserne to this event" with a local scan and never touch Overpass at
// request time. Same tile-walk, mirror-retry and per-tile checkpoint as
// scripts/build-industrial-index.ts (see the long comment there): ~1°×1°
// tiles, every full-planet mirror tried in rounds (never overpass.osm.ch —
// regional, see lib/landuse.ts), a pause between tiles, progress saved
// after every tile so a killed run resumes.
//
// `out center` here rather than `out bb`: a fire station is a point of
// contact, not a footprint a detection could land inside, so its centre is
// all the lookup needs.
//
// The phone number comes from OSM's `phone` / `contact:phone` tag ONLY —
// null when neither is present. Never inferred, never filled from a
// national number: the dashboard falls back to the generic Protection
// Civile number (lib/emergency-numbers.ts) at display time instead.
//
//   npm run build-firestation-index
import fs from 'node:fs';
import path from 'node:path';
import { displayName } from '../lib/place-name';
import { preferIpv4 } from '../lib/prefer-ipv4';
import { OVERPASS_ENDPOINTS } from '../lib/landuse';
import type { FireStation } from '../lib/firestation';

preferIpv4();

type Bbox = { west: number; south: number; east: number; north: number };
type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number; lon?: number; // nodes
  center?: { lat: number; lon: number }; // ways/relations, from `out center`
  tags?: Record<string, string>;
};
type OverpassResult = { elements: OverpassElement[] };

const TILE_DEG = 1.0;
const PAUSE_BETWEEN_TILES_MS = 2_500;
const PRIMARY_TIMEOUT_MS = 60_000;
const MIRROR_TIMEOUT_MS = 90_000;
const TILE_QUERY_TIMEOUT_S = 120;

const dataDir = path.join(process.cwd(), 'data');
const outPath = path.join(dataDir, 'fire-stations.json');
const progressPath = path.join(dataDir, '.firestation-index-progress.json');

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

// Overpass's own bbox order is south,west,north,east.
function tileQuery(tile: Bbox): string {
  const box = `${tile.south},${tile.west},${tile.north},${tile.east}`;
  return `[out:json][timeout:${TILE_QUERY_TIMEOUT_S}];\nnwr["amenity"="fire_station"](${box});\nout center;`;
}

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

// OSM's phone tags are free text ("+213 34 21 00 14", "034 21 00 14;14"...)
// — kept verbatim apart from whitespace trimming, so a tel: link carries
// exactly what the mapper entered. `;`-separated multi-values keep only the
// first number. An empty/blank tag counts as absent.
function phoneOf(tags: Record<string, string>): string | null {
  const raw = (tags.phone ?? tags['contact:phone'] ?? '').split(';')[0].trim();
  return raw ? raw : null;
}

function toStation(el: OverpassElement): FireStation | null {
  const tags = el.tags ?? {};
  if (tags.amenity !== 'fire_station') return null;
  let lat: number, lon: number;
  if (el.type === 'node') {
    if (el.lat === undefined || el.lon === undefined) return null;
    lat = el.lat; lon = el.lon;
  } else {
    if (!el.center) return null; // no geometry at all — drop rather than guess
    lat = el.center.lat; lon = el.center.lon;
  }
  const name = tags.name ? displayName({ name: tags.name, name_ar: tags['name:ar'], 'name:fr': tags['name:fr'] }) : null;
  return { osm_id: `${el.type}/${el.id}`, name: name || null, lat, lon, phone: phoneOf(tags) };
}

type Progress = { bbox: Bbox; completedTileIndexes: number[]; stationsById: Record<string, FireStation> };

function loadProgress(bbox: Bbox): Progress {
  try {
    const p = JSON.parse(fs.readFileSync(progressPath, 'utf8')) as Progress;
    if (JSON.stringify(p.bbox) === JSON.stringify(bbox)) return p;
    console.log('Progress file is for a different bbox — starting over.');
  } catch {
    // no progress file yet
  }
  return { bbox, completedTileIndexes: [], stationsById: {} };
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

  console.log(`Building fire-station index over bbox ${bbox.west},${bbox.south},${bbox.east},${bbox.north} (${tiles.length} tiles of ~${TILE_DEG}°).`);

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
      const station = toStation(el);
      if (!station) continue;
      if (!progress.stationsById[station.osm_id]) added++;
      progress.stationsById[station.osm_id] = station;
    }
    console.log(`  -> ${elements.length} element(s), ${added} new station(s) (total ${Object.keys(progress.stationsById).length})`);
    progress.completedTileIndexes.push(i);
    saveProgress(progress);
    await sleep(PAUSE_BETWEEN_TILES_MS);
  }

  const stations = Object.values(progress.stationsById);
  if (stations.length === 0) {
    console.error('Zero fire stations resolved. Old fire-stations.json (if any) left untouched.');
    process.exit(1);
  }

  const tmpPath = outPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(stations));
  fs.renameSync(tmpPath, outPath);
  fs.rmSync(progressPath, { force: true });

  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
  const named = stations.filter(s => s.name).length;
  const withPhone = stations.filter(s => s.phone).length;
  console.log(`\nWrote ${stations.length} fire station(s) to ${outPath} (${sizeKb} KB).`);
  console.log(`${named} named, ${stations.length - named} unnamed; ${withPhone} with an OSM phone tag.`);
}

main().catch(error => {
  console.error(`\nbuild-firestation-index FAILED: ${error instanceof Error ? error.message : error}`);
  console.error(`Progress saved to ${progressPath} — re-run to resume from the last completed tile.`);
  process.exit(1);
});
