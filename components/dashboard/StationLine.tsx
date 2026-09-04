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

import { PROTECTION_CIVILE_NUMBER } from '@/lib/emergency-numbers';
import type { DashboardEvent } from './types';

// The nearest-caserne line, shared by the list card, the popup and the
// detail panel so all three say exactly the same thing. Always ends in a
// tappable tel: link — the station's own OSM number when it has one, the
// generic Protection Civile number (14) otherwise. Never a dead end, never
// an invented station number: the fallback is labelled as the generic line.
export function stationTel(event: Pick<DashboardEvent, 'nearestStationPhone'>): { href: string; label: string; generic: boolean } {
  const own = event.nearestStationPhone?.trim();
  if (own) return { href: `tel:${own.replace(/[\s.()-]/g, '')}`, label: own, generic: false };
  return { href: `tel:${PROTECTION_CIVILE_NUMBER}`, label: `${PROTECTION_CIVILE_NUMBER} (Protection civile)`, generic: true };
}

export default function StationLine({ event, compact = false }: { event: DashboardEvent; compact?: boolean }) {
  if (!event.nearestStationLine) return null;
  const tel = stationTel(event);
  return (
    <span className={compact ? '' : 'block'}>
      🚒 {event.nearestStationLine}
      {' · '}
      <a href={tel.href} onClick={e => e.stopPropagation()} className="whitespace-nowrap font-semibold text-[#63dda0] underline decoration-dotted underline-offset-2 hover:text-white" title={tel.generic ? 'Aucun numéro OSM pour cette caserne — numéro national de la Protection civile' : 'Numéro OSM de la caserne'}>
        📞 {tel.label}
      </a>
    </span>
  );
}
