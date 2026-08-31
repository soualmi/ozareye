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

// Fetches admin-level-1 (province/state/wilaya-equivalent) boundaries for any
// country and writes them to data/wilayas.geojson in the exact shape
// lib/wilaya.ts already consumes ({properties:{name}, geometry}) — nothing in
// wilaya.ts changes: point-in-polygon and the "wilaya" naming stay exactly as
// they are, this just feeds them a different country's polygons (see README
// section 5 / the task that added this file).
//
// Source: geoBoundaries (geoboundaries.org), a public, versioned, per-country
// open dataset of administrative boundaries (CC BY 4.0 / ODbL depending on
// the underlying source, itself largely OSM-derived) — chosen over raw
// Overpass admin_level relations because assembling relation ways into
// correct polygon rings is a real geometry problem geoBoundaries has already
// solved and published as ready GeoJSON, per country, by ISO3 code.
import fs from 'node:fs';
import path from 'node:path';

type GeoBoundariesMeta = { gjDownloadURL?: string };
type RawFeature = { properties?: { shapeName?: string }; geometry: unknown };
type RawGeoJSON = { features?: RawFeature[] };

export type AdminBoundariesResult =
  | { ok: true; regionCount: number }
  | { ok: false; error: string };

const HEADERS = { 'user-agent': 'Algerie-Feux-Alerte-Setup/1.0', accept: 'application/json' };

function writeEmptyBoundaries(outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = outputPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify({ type: 'FeatureCollection', features: [] }));
  fs.renameSync(tmpPath, outputPath);
}

// countryIso3 is the ISO 3166-1 alpha-3 code (e.g. 'DZA', 'LUX') — geoBoundaries
// indexes by alpha-3, not alpha-2. On any failure this writes an EMPTY
// FeatureCollection rather than leaving a stale or wrong-country file behind:
// wilayaAt() reading an empty collection just returns null for everyone
// (graceful "no admin attribution"), never a crash and never a silently
// mismatched country's polygons.
export async function buildAdminBoundaries(countryIso3: string, outputPath: string, onProgress?: (message: string) => void): Promise<AdminBoundariesResult> {
  const log = onProgress ?? (() => {});
  try {
    log(`Recherche des frontières administratives pour ${countryIso3} (geoBoundaries)...`);
    const metaRes = await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${countryIso3}/ADM1/`, { headers: HEADERS });
    if (!metaRes.ok) throw new Error(`geoBoundaries : HTTP ${metaRes.status}`);
    const meta = await metaRes.json() as GeoBoundariesMeta;
    if (!meta.gjDownloadURL) throw new Error('geoBoundaries : aucune frontière ADM1 disponible pour ce pays');

    log('Téléchargement du GeoJSON des frontières...');
    const geoRes = await fetch(meta.gjDownloadURL, { headers: HEADERS });
    if (!geoRes.ok) throw new Error(`Téléchargement du GeoJSON : HTTP ${geoRes.status}`);
    const raw = await geoRes.json() as RawGeoJSON;
    const rawFeatures = raw.features ?? [];
    if (rawFeatures.length === 0) throw new Error('Le GeoJSON reçu ne contient aucune frontière');

    // Remap geoBoundaries' `shapeName` to the `name` property lib/wilaya.ts
    // reads — the only shape translation needed; geometry passes through
    // untouched (Polygon/MultiPolygon, [lon,lat] rings, same as before).
    const features = rawFeatures.map(f => ({
      type: 'Feature' as const,
      properties: { name: f.properties?.shapeName ?? 'Région inconnue' },
      geometry: f.geometry,
    }));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const tmpPath = outputPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ type: 'FeatureCollection', features }));
    fs.renameSync(tmpPath, outputPath);

    log(`${features.length} région(s) administrative(s) écrites.`);
    return { ok: true, regionCount: features.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Frontières administratives indisponibles (${message}) — repli sur "sans rattachement administratif".`);
    writeEmptyBoundaries(outputPath);
    return { ok: false, error: message };
  }
}
