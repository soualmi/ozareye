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

// Display-only naming for satellite platforms. FIRMS speaks two dialects for
// the same three spacecraft: the per-row CSV `satellite` code ("N20", "N21",
// "N" — which renders as a bare, meaningless "N" in the pass list) and the
// feed/source name used by FIRMS_SOURCES and the source_health table
// ("VIIRS_NOAA20_NRT"). Both map to the one name a reader recognises. An
// unknown string is shown verbatim rather than guessed at or hidden.
const SATELLITE_NAMES: Record<string, string> = {
  VIIRS_NOAA20_NRT: 'NOAA-20', N20: 'NOAA-20',
  VIIRS_NOAA21_NRT: 'NOAA-21', N21: 'NOAA-21',
  VIIRS_SNPP_NRT: 'Suomi-NPP', N: 'Suomi-NPP',
};

export function satelliteName(raw: string): string {
  return SATELLITE_NAMES[raw] ?? raw;
}
