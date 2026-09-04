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

import { EMERGENCY_NUMBERS } from '@/lib/emergency-numbers';

// Static, always-visible block at the top of the side panel: the 5 verified
// national emergency numbers, each a tel: link. No logic, no per-event
// data — the same panel on every tab, every event, every wilaya.
export default function EmergencyNumbers() {
  return (
    <div data-testid="emergency-numbers" className="border-b border-white/10 bg-[#ff5b32]/10 px-3 py-2 text-[11px]">
      <p className="mb-1 font-semibold uppercase tracking-wide text-[#ff9270]">Numéros d&apos;urgence</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[#edf5ef]">
        {EMERGENCY_NUMBERS.map(item => (
          <li key={item.label} className="whitespace-nowrap">
            <span className="text-[#c9dbd3]">{item.label} :</span>{' '}
            {item.numbers.map((n, i) => (
              <span key={n}>
                {i > 0 && <span className="text-[#8da79d]"> ou </span>}
                <a href={`tel:${n}`} className="font-semibold text-[#63dda0] underline decoration-dotted underline-offset-2 hover:text-white">{n}</a>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
