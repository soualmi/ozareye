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

import { isAuthenticated } from '@/lib/dashboard-auth';

// Looks up a country's default bounding box on demand (only when the user
// picks it in step 3 of /setup) via Nominatim, OpenStreetMap's own geocoder
// — rather than pre-baking all 249 countries' bboxes as a static asset, which
// would need a periodic external refresh to stay accurate. The numeric bbox
// fields on /setup are always editable directly too, so a Nominatim outage
// degrades to "type it in yourself", not a dead end.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const name = new URL(request.url).searchParams.get('name');
  if (!name) return Response.json({ error: 'Paramètre name requis' }, { status: 400 });

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('country', name);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    const response = await fetch(url, { headers: { 'user-agent': 'Algerie-Feux-Alerte-Setup/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const results = await response.json() as { boundingbox?: [string, string, string, string] }[];
    const box = results[0]?.boundingbox;
    if (!box) return Response.json({ error: 'Zone introuvable pour ce pays — saisissez la zone manuellement.' }, { status: 404 });

    const [south, north, west, east] = box.map(Number);
    return Response.json({ bbox: { west, south, east, north } });
  } catch {
    return Response.json({ error: 'Service de géocodage indisponible — saisissez la zone manuellement.' }, { status: 502 });
  }
}
