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

import fs from 'node:fs';
import path from 'node:path';

// Ray-casting point-in-polygon against real wilaya boundaries — no GIS
// dependency. Fixes the earlier nearest-village wilaya guess, which gave a
// coin-flip answer for any fire near a wilaya border (e.g. Jijel/Béjaïa).
// Source: https://github.com/fr33dz/Algeria-geojson (all-wilayas.geojson),
// fetched once to ./data/wilayas.geojson — never re-fetched at runtime.

type Ring = number[][]; // [lon, lat][] — GeoJSON coordinate order
type PolygonCoords = Ring[]; // exterior ring + hole rings
type GeoJSONFeature = {
  properties: { name: string; name_ar?: string };
  geometry: { type: 'Polygon'; coordinates: PolygonCoords } | { type: 'MultiPolygon'; coordinates: PolygonCoords[] };
};
type GeoJSON = { features: GeoJSONFeature[] };

type WilayaShape = { name: string; bbox: [number, number, number, number]; polygons: PolygonCoords[] };

let cache: WilayaShape[] | null = null;

function bboxOf(polygons: PolygonCoords[]): [number, number, number, number] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const rings of polygons) for (const ring of rings) for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

// Standard even-odd ray cast. Holes are just extra rings: a point inside both
// the exterior ring and a hole ring toggles twice (in, then back out), which is
// the well-known trick for handling polygons-with-holes without extra logic.
function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, rings: PolygonCoords): boolean {
  let inside = false;
  for (const ring of rings) if (pointInRing(lon, lat, ring)) inside = !inside;
  return inside;
}

function loadWilayas(): WilayaShape[] {
  if (cache) return cache;
  const filePath = path.join(process.cwd(), 'data', 'wilayas.geojson');
  const geojson = JSON.parse(fs.readFileSync(filePath, 'utf8')) as GeoJSON;
  cache = geojson.features.map(f => {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return { name: f.properties.name, bbox: bboxOf(polygons), polygons };
  });
  return cache;
}

export function wilayaAt(lat: number, lon: number): string | null {
  for (const w of loadWilayas()) {
    const [minLon, minLat, maxLon, maxLat] = w.bbox;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    for (const polygon of w.polygons) if (pointInPolygon(lon, lat, polygon)) return w.name;
  }
  return null;
}

// For the dashboard's wilaya filter dropdown.
export function allWilayaNames(): string[] {
  return loadWilayas().map(w => w.name).sort((a, b) => a.localeCompare(b, 'fr'));
}

// Called by the /setup region build after it overwrites data/wilayas.geojson
// with a new country's boundaries, so the running server picks up the new
// polygons on its very next lookup instead of serving the previous country's
// cached shapes until restarted. wilayaAt()/allWilayaNames() still don't care
// whose boundaries they're reading — this only forces the next call to reload.
export function invalidateWilayaCache(): void {
  cache = null;
}
