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

// Algeria's national emergency numbers — static configuration, verified
// against multiple official sources on 2026-09-04, used exactly as given.
// Rendered as tel: links in the dashboard's always-visible panel and as the
// fallback number when the nearest fire station has no OSM phone tag
// (lib/firestation.ts). Pure constants: no node:fs, safe in client bundles.
// A new country gets its own list here, not a scraped/inferred one.
export type EmergencyNumber = { label: string; numbers: string[] };

export const EMERGENCY_NUMBERS: EmergencyNumber[] = [
  { label: 'Protection civile (pompiers)', numbers: ['14', '1021'] },
  { label: 'SAMU (urgence médicale)', numbers: ['16'] },
  { label: 'Police', numbers: ['17', '1548'] },
  { label: 'Gendarmerie nationale', numbers: ['1055'] },
  { label: 'Direction générale des forêts', numbers: ['1070'] },
];

// The number a fire-station line falls back to when OSM carries no phone
// for that station — always something callable, never a dead end.
export const PROTECTION_CIVILE_NUMBER = '14';
