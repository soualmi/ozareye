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
