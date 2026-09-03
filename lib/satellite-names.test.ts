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

// Guards the one thing this mapping exists to prevent: a raw FIRMS code
// reaching the UI, where "N" reads as a typo rather than as Suomi-NPP.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { satelliteName } from './satellite-names';

test('maps FIRMS source names to readable platform names', () => {
  assert.equal(satelliteName('VIIRS_NOAA20_NRT'), 'NOAA-20');
  assert.equal(satelliteName('VIIRS_NOAA21_NRT'), 'NOAA-21');
  assert.equal(satelliteName('VIIRS_SNPP_NRT'), 'Suomi-NPP');
});

test('maps the per-detection CSV satellite codes, including the bare "N"', () => {
  assert.equal(satelliteName('N20'), 'NOAA-20');
  assert.equal(satelliteName('N21'), 'NOAA-21');
  assert.equal(satelliteName('N'), 'Suomi-NPP');
});

test('shows an unknown source verbatim rather than guessing', () => {
  assert.equal(satelliteName('MODIS_A'), 'MODIS_A');
  assert.equal(satelliteName(''), '');
});
