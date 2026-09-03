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

// One rule for how a place is named on screen and in alerts.
//
// OSM in Algeria stores a locality's name in whatever mix of scripts mappers
// added: "Kouba ⴽⵓⴱⴰ القبة" (Latin + Tifinagh + Arabic in one string),
// "غار الذيبة ⵖⴰⵔ ⴷⴷⵉⴱⴰ" (Arabic + Tifinagh, no Latin at all), or plain
// "Tamdichte". Tifinagh is unreadable to essentially every reader of these
// alerts and, worse, renders as boxes on most phones — so it is never shown,
// in any position, by any caller.
//
// Order of preference: an explicit French name, then the Latin-script part of
// the mixed name, then Arabic (which real readers here do read), then whatever
// is left with Tifinagh removed. The Arabic fallback still needs the bidi
// isolation biText() applies — this function decides WHICH string is shown,
// not how it is embedded in a line of text.

// Tifinagh block, plus the extended block that a few Kabyle names use.
const TIFINAGH = /[ⴰ-⵿]/gu;
// Latin letters, digits and the punctuation that legitimately appears inside a
// transliterated name ("Aït Djamaâ", "Tizi n Temridjt", "Bordj Bou Arreridj",
// "It Leɛziz" — note the ɛ, a Latin Extended letter Kabyle uses).
const LATIN_NAME_CHAR = /[A-Za-zÀ-ÿŒœƐɛƷʒ0-9'’\-.\s]/u;
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u;

export type NamedPlace = {
  name: string;
  name_ar?: string | null;
  /** OSM `name:fr`, if a future index regeneration carries it. */
  'name:fr'?: string | null;
  name_fr?: string | null;
};

export function stripTifinagh(value: string): string {
  return value.replace(TIFINAGH, '').replace(/\s{2,}/g, ' ').trim();
}

/** The leading Latin-script run of a mixed-script name, cut at the first
 *  character belonging to another script. "Oran ⵡⴰⵀⵔⴻⵏ وهران" -> "Oran". */
function latinPrefix(value: string): string {
  let out = '';
  for (const char of value) {
    if (!LATIN_NAME_CHAR.test(char)) break;
    out += char;
  }
  return out.replace(/[\s'’\-.]+$/u, '').trim();
}

function arabicRun(value: string): string {
  const chars = [...value];
  const start = chars.findIndex(c => ARABIC.test(c));
  if (start === -1) return '';
  let out = '';
  for (let i = start; i < chars.length; i++) {
    const char = chars[i];
    if (ARABIC.test(char) || /[\s'’\-.]/u.test(char)) out += char;
    else break;
  }
  return out.trim();
}

export function displayName(place: NamedPlace): string {
  const french = place['name:fr'] ?? place.name_fr;
  if (french && stripTifinagh(french)) return stripTifinagh(french);

  const raw = place.name ?? '';
  const latin = latinPrefix(raw);
  // Two characters is the shortest real name here ("At"); a single stray
  // letter before a script switch is noise, not a name.
  if (latin.length >= 2) return latin;

  const arabic = place.name_ar ? stripTifinagh(place.name_ar) : '';
  if (arabic) return arabic;

  const inlineArabic = arabicRun(stripTifinagh(raw));
  if (inlineArabic) return inlineArabic;

  return stripTifinagh(raw);
}

// Bidi isolation for the case where displayName() had to fall back to Arabic:
// an Arabic run sitting directly against Latin text (a distance, a label) can
// visually reorder at the boundary without explicit isolates — the bytes stay
// correct, the rendering does not. Latin names need no isolation, so they are
// returned untouched rather than wrapped in invisible controls.
const RLI = '⁧', PDI = '⁩';

export function isolatedDisplayName(place: NamedPlace): string {
  const shown = displayName(place);
  return ARABIC.test(shown) ? `${RLI}${shown}${PDI}` : shown;
}
