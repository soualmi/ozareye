// Regenerates the village index (data/villages.json, or a custom output path)
// for any bounding box, by querying OpenStreetMap's Overpass API live and
// attributing each result to a wilaya/region via lib/wilaya.ts. This is the
// query that was used to build the shipped Algeria index in the first place
// — preserved here (it wasn't saved anywhere before) so it can be rerun for
// Algeria or adapted to another region (see README section 5).
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
// Usage:
//   npx tsx scripts/build-villages.ts <west,south,east,north> [output-path]
//
// Requires data/wilayas.geojson (or your own equivalent admin-boundary
// GeoJSON at that path — see README section 5) to already be in place:
// wilayaAt() attributes each village to a region from it, and any node
// outside every polygon in that file is dropped, not guessed.
import fs from 'node:fs';
import path from 'node:path';
import { wilayaAt } from '../lib/wilaya';

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

// Overpass's own bbox order is south,west,north,east — the opposite corner
// pairing from this project's west,south,east,north convention used
// everywhere else (ALGERIA_BOX, the replay script's bbox arg). Do not swap
// these by copy-paste between the two.
const overpassBbox = `${south},${west},${north},${east}`;
const query = `[out:json][timeout:180];
node["place"~"^(city|town|village|hamlet)$"](${overpassBbox});
out body;`;

type OverpassElement = { type: string; id: number; lat: number; lon: number; tags?: Record<string, string> };
type OverpassResult = { elements: OverpassElement[] };
type Village = { osm_id: string; name: string; name_ar: string | null; lat: number; lon: number; place: string; wilaya: string };

async function main() {
  console.log(`Querying Overpass for bbox ${bboxArg} (place nodes: city/town/village/hamlet)...`);
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    // Overpass's Apache front-end 406s requests with no User-Agent/Accept —
    // matches the header fire-monitor.ts already sends to the FIRMS API.
    headers: { 'content-type': 'text/plain', 'user-agent': 'Algerie-Feux-Alerte/1.0', accept: '*/*' },
    body: query,
  });
  if (!response.ok) {
    console.error(`Overpass request failed: HTTP ${response.status}\n${await response.text()}`);
    process.exit(1);
  }
  const raw = await response.json() as OverpassResult;
  console.log(`Overpass returned ${raw.elements.length} node(s).`);

  const out: Village[] = [];
  let droppedOutsideBoundary = 0;
  const perRegion: Record<string, number> = {};

  for (const el of raw.elements) {
    if (el.type !== 'node' || !el.tags?.name || !el.tags?.place) continue;
    const region = wilayaAt(el.lat, el.lon);
    if (!region) { droppedOutsideBoundary++; continue; }
    out.push({ osm_id: `node/${el.id}`, name: el.tags.name, name_ar: el.tags['name:ar'] ?? null, lat: el.lat, lon: el.lon, place: el.tags.place, wilaya: region });
    perRegion[region] = (perRegion[region] ?? 0) + 1;
  }

  if (out.length === 0) {
    console.error(`Zero villages resolved inside any boundary from data/wilayas.geojson. Nothing written to ${outputPath}.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(out));
  fs.renameSync(tmpPath, outputPath);

  console.log(`Wrote ${out.length} villages to ${outputPath} (dropped ${droppedOutsideBoundary} outside any boundary).`);
  console.log('Per-region counts:');
  for (const [region, count] of Object.entries(perRegion).sort((a, b) => b[1] - a[1])) console.log(`  ${region}: ${count}`);
}

main();
