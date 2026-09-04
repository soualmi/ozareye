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

import { elapsedParts } from '@/lib/fire-monitor';

export function formatAge(minutes: number): string {
  const { days, hours, minutes: m } = elapsedParts(minutes);
  if (days > 0) return hours === 0 ? `${days} j` : `${days} j ${hours} h`;
  if (hours > 0) return m === 0 ? `${hours} h` : `${hours} h ${m}`;
  return `${minutes} min`;
}

// A detection outside every wilaya polygon isn't a data error — it's a real
// point at sea or across a border. "Wilaya inconnue" read as a lookup bug;
// this says what it actually is.
export function wilayaLabel(wilaya: string | null | undefined): string {
  return wilaya ?? 'Hors frontières / en mer';
}

// "il y a 2h 15min" — spelled out for the per-event freshness line, kept
// separate from formatAge's compact "2 h 15" used in dense contexts.
export function formatDetectedAgo(minutes: number): string {
  const { days, hours, minutes: m } = elapsedParts(minutes);
  if (days > 0) return hours === 0 ? `${days}j` : `${days}j ${hours}h`;
  if (hours > 0) return m === 0 ? `${hours}h` : `${hours}h ${m}min`;
  return `${minutes}min`;
}
