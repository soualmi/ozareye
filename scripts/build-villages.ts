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

// Regenerates the village index (data/villages.json, or a custom output path)
// for any bounding box, by querying OpenStreetMap's Overpass API live and
// attributing each result to a region via lib/wilaya.ts. This is the query
// that was used to build the shipped Algeria index in the first place —
// preserved here (it wasn't saved anywhere before) so it can be rerun for
// Algeria or adapted to another region (see README section 5).
//
// buildVillages() is the reusable core, called both by the CLI below and by
// app/api/setup/build/route.ts (the /setup screen's "Générer les données de
// la région" button) — one query, in-process, instead of a duplicated copy
// or a shelled-out subprocess.
//
// Unlike scripts/build-village-index.ts (which transforms an already-fetched
// raw Overpass JSON dump and never touches the network itself), this script
// does the fetch too — convenient for a one-shot regeneration, at the cost of
// depending on the public Overpass API being up. For more control over the
// query (a different `place` filter, a non-bbox area selector, splitting a
// huge query into chunks) query Overpass yourself (e.g. via
// https://overpass-turbo.eu/) and feed the raw JSON to build-village-index.ts
// instead.
//
// CLI usage:
//   npx tsx scripts/build-villages.ts <west,south,east,north> [output-path]
//
// Requires data/wilayas.geojson (or your own equivalent admin-boundary
// GeoJSON at that path — see README section 5) to already be in place:
// wilayaAt() attributes each village to a region from it, and any node
// outside every polygon in that file is dropped, not guessed.
import fs from 'node:fs';
import path from 'node:path';
import { wilayaAt } from '../lib/wilaya';

export type Bbox = { west: number; south: number; east: number; north: number };
type OverpassElement = { type: string; id: number; lat: number; lon: number; tags?: Record<string, string> };
type OverpassResult = { elements: OverpassElement[] };
// `name:fr` is carried through so displayName() can prefer an explicit French
// name over guessing at the Latin part of a mixed-script `name`. The shipped
// index predates this and has none; it appears on the next regeneration.
type Village = { osm_id: string; name: string; name_ar: string | null; 'name:fr'?: string | null; lat: number; lon: number; place: string; wilaya: string };
export type BuildVillagesResult = { count: number; droppedOutsideBoundary: number; perRegion: Record<string, number> };

export function bboxToString(bbox: Bbox): string {
  return `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
}

export async function buildVillages(bbox: Bbox, outputPath: string, onProgress?: (message: string) => void): Promise<BuildVillagesResult> {
  const log = onProgress ?? (() => {});
  const { west, south, east, north } = bbox;

  // Overpass's own bbox order is south,west,north,east — the opposite corner
  // pairing from this project's west,south,east,north convention used
  // everywhere else (the config bbox, the replay script's bbox arg). Do not
  // swap these by copy-paste between the two.
  const overpassBbox = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:180];
node["place"~"^(city|town|village|hamlet)$"](${overpassBbox});
out body;`;

  log(`Interrogation d'Overpass pour la zone ${bboxToString(bbox)} (villes/villages/hameaux)...`);
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    // Overpass's Apache front-end 406s requests with no User-Agent/Accept —
    // matches the header fire-monitor.ts already sends to the FIRMS API.
    headers: { 'content-type': 'text/plain', 'user-agent': 'OzarEye/1.0', accept: '*/*' },
    body: query,
  });
  if (!response.ok) {
    throw new Error(`Requête Overpass échouée : HTTP ${response.status}\n${await response.text()}`);
  }
  const raw = await response.json() as OverpassResult;
  log(`Overpass a retourné ${raw.elements.length} nœud(s).`);

  const out: Village[] = [];
  let droppedOutsideBoundary = 0;
  const perRegion: Record<string, number> = {};

  for (const el of raw.elements) {
    if (el.type !== 'node' || !el.tags?.name || !el.tags?.place) continue;
    const region = wilayaAt(el.lat, el.lon);
    if (!region) { droppedOutsideBoundary++; continue; }
    out.push({ osm_id: `node/${el.id}`, name: el.tags.name, name_ar: el.tags['name:ar'] ?? null, 'name:fr': el.tags['name:fr'] ?? null, lat: el.lat, lon: el.lon, place: el.tags.place, wilaya: region });
    perRegion[region] = (perRegion[region] ?? 0) + 1;
  }

  if (out.length === 0) {
    throw new Error(`Zéro village résolu à l'intérieur d'une frontière administrative connue. Rien n'a été écrit dans ${outputPath}.`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(out));
  fs.renameSync(tmpPath, outputPath);

  log(`${out.length} villages écrits dans ${outputPath} (${droppedOutsideBoundary} écartés, hors de toute frontière connue).`);
  return { count: out.length, droppedOutsideBoundary, perRegion };
}

async function main() {
  const bboxArg = process.argv[2];
  if (!bboxArg) {
    console.error('usage: npx tsx scripts/build-villages.ts <west,south,east,north> [output-path]');
    process.exit(1);
  }
  const [west, south, east, north] = bboxArg.split(',').map(Number);
  if ([west, south, east, north].some(n => !Number.isFinite(n))) {
    console.error(`Invalid bbox "${bboxArg}" — expected west,south,east,north as decimal degrees.`);
    process.exit(1);
  }
  const outputPath = path.resolve(process.argv[3] ?? path.join(process.cwd(), 'data', 'villages.json'));

  try {
    const result = await buildVillages({ west, south, east, north }, outputPath, msg => console.log(msg));
    console.log('Per-region counts:');
    for (const [region, count] of Object.entries(result.perRegion).sort((a, b) => b[1] - a[1])) console.log(`  ${region}: ${count}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly (`tsx scripts/build-villages.ts`),
// not when imported by the setup API route.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
