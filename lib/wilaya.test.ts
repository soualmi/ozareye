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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wilayaAt } from './wilaya';

test('Béjaïa city center resolves to Béjaïa', () => {
  assert.equal(wilayaAt(36.7511783, 5.0643687), 'Béjaïa');
});

test('Tizi Ouzou city center resolves to Tizi Ouzou', () => {
  assert.equal(wilayaAt(36.7137843, 4.0493919), 'Tizi Ouzou');
});

// This is the exact coordinate (replay alert 18) that the old nearest-village
// method could only guess at: the closest indexed point was tagged Jijel at
// 0.30km, but a Béjaïa-tagged point sat only 0.57km away — a coin flip. Real
// polygon boundaries settle it authoritatively instead of by proximity luck.
test('point near the Jijel/Béjaïa border resolves by real boundary, not proximity', () => {
  assert.equal(wilayaAt(36.6246, 5.4891), 'Jijel');
});
