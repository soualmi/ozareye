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
import { villagesInBounds } from '@/lib/fire-monitor';

// Never ships the full ~9,635-village index — only what's in the current
// viewport, and only called by the map past its zoom threshold.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const bounds = url.searchParams.get('bounds');
  if (!bounds) return Response.json({ error: 'Paramètre bounds requis (south,west,north,east)' }, { status: 400 });
  const [south, west, north, east] = bounds.split(',').map(Number);
  if ([south, west, north, east].some(n => !Number.isFinite(n))) return Response.json({ error: 'bounds invalide' }, { status: 400 });

  return Response.json({ villages: villagesInBounds(south, west, north, east) });
}
