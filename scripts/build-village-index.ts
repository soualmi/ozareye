// Algérie Feux Alerte
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

// One-time (re-)build of data/villages.json from a raw Overpass JSON dump.
// Never queries Overpass itself — that's a manual step (see README) so the
// live app never depends on Overpass at runtime. Refuses to overwrite the
// existing index unless the result is non-empty and well-formed: never ship a
// half-built index.
import fs from 'node:fs';
import path from 'node:path';
import { wilayaAt } from '../lib/wilaya';

const rawPath = process.argv[2];
if (!rawPath) { console.error('usage: tsx scripts/build-village-index.ts <raw-overpass-json>'); process.exit(1); }

type OverpassElement = { type: string; id: number; lat: number; lon: number; tags?: Record<string, string> };
type OverpassResult = { elements: OverpassElement[] };

let raw: OverpassResult;
try {
  raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as OverpassResult;
} catch (error) {
  console.error(`Failed to read/parse ${rawPath}: ${error instanceof Error ? error.message : error}. Old villages.json left untouched.`);
  process.exit(1);
}
if (!raw.elements || raw.elements.length === 0) {
  console.error('Overpass result has zero elements. Old villages.json left untouched.');
  process.exit(1);
}

type Village = { osm_id: string; name: string; name_ar: string | null; lat: number; lon: number; place: string; wilaya: string };
const out: Village[] = [];
let droppedOutsideAlgeria = 0;
const perWilaya: Record<string, number> = {};

for (const el of raw.elements) {
  if (el.type !== 'node' || !el.tags?.name || !el.tags?.place) continue;
  const wilaya = wilayaAt(el.lat, el.lon);
  if (!wilaya) { droppedOutsideAlgeria++; continue; }
  out.push({ osm_id: `node/${el.id}`, name: el.tags.name, name_ar: el.tags['name:ar'] ?? null, lat: el.lat, lon: el.lon, place: el.tags.place, wilaya });
  perWilaya[wilaya] = (perWilaya[wilaya] ?? 0) + 1;
}

if (out.length === 0) {
  console.error('Zero villages resolved inside an Algerian wilaya. Old villages.json left untouched.');
  process.exit(1);
}

const finalPath = path.join(process.cwd(), 'data', 'villages.json');
const tmpPath = finalPath + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(out));
fs.renameSync(tmpPath, finalPath);

console.log(`Wrote ${out.length} villages to ${finalPath} (dropped ${droppedOutsideAlgeria} outside any Algerian wilaya).`);
console.log('Per-wilaya counts:');
for (const [w, c] of Object.entries(perWilaya).sort((a, b) => b[1] - a[1])) console.log(`  ${w}: ${c}`);
