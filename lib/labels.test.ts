import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABELS } from './fire-monitor';

// Regression guard for the "immédيate" bug: a bidi rendering artifact traced back
// to Arabic and French runs being concatenated without directional isolation
// (fixed in biText()). This test guards the other possible root cause — an
// actual data-level mix-up (wrong template slot, swapped fr/ar) — by asserting
// the French half of every label is pure Latin/Latin-punctuation, no Arabic-range
// codepoints anywhere in it.
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

test('every LABELS.*.fr string contains no Arabic-range codepoints', () => {
  for (const [key, { fr }] of Object.entries(LABELS)) {
    assert.equal(ARABIC_RANGE.test(fr), false, `LABELS.${key}.fr ("${fr}") contains an Arabic-range codepoint`);
  }
});

test('every LABELS.*.ar string contains at least one Arabic-range codepoint', () => {
  for (const [key, { ar }] of Object.entries(LABELS)) {
    assert.equal(ARABIC_RANGE.test(ar), true, `LABELS.${key}.ar ("${ar}") has no Arabic-range codepoint`);
  }
});
