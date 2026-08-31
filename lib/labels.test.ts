import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABELS } from './fire-monitor';

// System labels are French-only. Village names are exempt — they're data (an
// OSM name/name_ar pair, sometimes Kabyle-only), not template text, and keep
// their Arabic/Kabyle form via biText() in telegramText().
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

test('every LABELS.* string is French-only, no Arabic-range codepoints', () => {
  for (const [key, value] of Object.entries(LABELS)) {
    assert.equal(ARABIC_RANGE.test(value), false, `LABELS.${key} ("${value}") contains an Arabic-range codepoint`);
  }
});
