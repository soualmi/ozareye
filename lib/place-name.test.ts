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

// The guarantee this module exists for: no Tifinagh ever reaches a reader.
// The four resolution cases are tested explicitly, then the guarantee itself
// is checked as a property over the real shipped village index.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { displayName, stripTifinagh, withDisplayName } from './place-name';

const TIFINAGH = /[ⴰ-⵿]/u;

test('(a) an explicit French name wins', () => {
  assert.equal(displayName({ name: 'Kouba ⴽⵓⴱⴰ القبة', name_ar: 'القبة', 'name:fr': 'Kouba' }), 'Kouba');
  assert.equal(displayName({ name: 'قسنطينة ⵇⵙⵏⵟⵉⵏⴰ', name_ar: 'قسنطينة', name_fr: 'Constantine' }), 'Constantine');
});

test('(b) otherwise the Latin-script part of the mixed name', () => {
  assert.equal(displayName({ name: 'Oran ⵡⴰⵀⵔⴻⵏ وهران', name_ar: 'وهران' }), 'Oran');
  assert.equal(displayName({ name: 'Boumerdès ⴱⵓⵎⴻⵔⴷⴰⵙ بومرداس', name_ar: 'بومرداس' }), 'Boumerdès');
  assert.equal(displayName({ name: 'Aït Djamaâ', name_ar: null }), 'Aït Djamaâ');
  // Kabyle Latin orthography uses ɛ — it must survive, not truncate the name.
  assert.equal(displayName({ name: 'It Leɛziz', name_ar: null }), 'It Leɛziz');
});

test('(c) Arabic when there is no usable Latin part, Tifinagh stripped', () => {
  assert.equal(displayName({ name: 'غار الذيبة ⵖⴰⵔ ⴷⴷⵉⴱⴰ', name_ar: 'غار الذيبة' }), 'غار الذيبة');
  // No name_ar field: the Arabic run inside `name` is used instead.
  assert.equal(displayName({ name: 'أزيار ⴰⵣⵢⴰⵔ', name_ar: null }), 'أزيار');
});

test('(d) last resort: the raw name with Tifinagh removed', () => {
  assert.equal(displayName({ name: 'ⵜⴰⵎⴷⵉⵛⵜ', name_ar: null }), '');
  assert.equal(displayName({ name: 'A ⵜⴰⵎⴷⵉⵛⵜ', name_ar: null }), 'A');
  assert.equal(stripTifinagh('Kouba ⴽⵓⴱⴰ القبة'), 'Kouba القبة');
});

test('never leaks Tifinagh over the shipped village index', () => {
  const villages = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'villages.json'), 'utf8')) as { name: string; name_ar: string | null }[];
  assert.ok(villages.length > 1000, 'expected the real index, not a stub');
  const withTifinagh = villages.filter(v => TIFINAGH.test(v.name) || (v.name_ar && TIFINAGH.test(v.name_ar)));
  assert.ok(withTifinagh.length > 100, `sample must actually contain Tifinagh names, found ${withTifinagh.length}`);
  for (const v of villages) {
    const shown = displayName(v);
    assert.ok(!TIFINAGH.test(shown), `Tifinagh leaked for ${JSON.stringify(v.name)} -> ${JSON.stringify(shown)}`);
  }
});

test('resolves to a non-empty name for essentially every shipped village', () => {
  const villages = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'villages.json'), 'utf8')) as { name: string; name_ar: string | null }[];
  const empty = villages.filter(v => !displayName(v));
  // A name that is Tifinagh and nothing else has no readable form to fall back
  // to; that must stay rare enough to notice if it grows.
  assert.ok(empty.length < villages.length * 0.01, `${empty.length}/${villages.length} villages resolve to an empty name`);
});

test('withDisplayName sanitises what leaves the API, name_ar included', () => {
  const out = withDisplayName({ name: 'Relizane ⴴⵉⵍⵉⵣⴰⵏ غليزان', name_ar: 'غليزان ⵖⵉⵍⵉⵣⴰⵏ', osm_id: 'node/1' } as never) as { name: string; name_ar: string | null };
  assert.equal(out.name, 'Relizane');
  assert.ok(!TIFINAGH.test(out.name_ar ?? ''), 'name_ar must not carry Tifinagh onto the wire either');
  assert.equal(out.name_ar, 'غليزان');
});
