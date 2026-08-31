import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blowsTowardDeg, classifyExposure } from './wind';

// Hand-computed case: fire at (36.00, 5.00). Wind direction reading is 270°
// (meteorological convention = wind is coming FROM the west), which means it
// physically blows TOWARD the east (90°). A village due east of the fire sits
// in the smoke's path and MUST be classified downwind. If FROM/TOWARD were
// ever swapped, this village would wrongly come out upwind — that is exactly
// the inversion bug this test exists to catch.
test('wind FROM west blows TOWARD east — village due east is downwind, not upwind', () => {
  const fire = { lat: 36.0, lon: 5.0 };
  const villageEast = { lat: 36.0, lon: 5.1 };
  const windDirectionFromDeg = 270;

  assert.equal(blowsTowardDeg(windDirectionFromDeg), 90);

  const result = classifyExposure(fire, villageEast, windDirectionFromDeg);
  assert.equal(result.relation, 'downwind');
  assert.ok(result.angleFromDownwindDeg <= 10, `expected near-zero angle, got ${result.angleFromDownwindDeg}`);
});

// Same wind (FROM west / TOWARD east), but the village is due WEST of the fire —
// i.e. on the upwind side, behind the fire relative to where the smoke travels.
// It must never be classified downwind or trigger an alert.
test('wind FROM west blows TOWARD east — village due west is upwind', () => {
  const fire = { lat: 36.0, lon: 5.0 };
  const villageWest = { lat: 36.0, lon: 4.9 };
  const windDirectionFromDeg = 270;

  const result = classifyExposure(fire, villageWest, windDirectionFromDeg);
  assert.equal(result.relation, 'upwind');
});

test('a village roughly 45-75 degrees off the downwind axis is marginal, not downwind or upwind', () => {
  // Wind FROM south (180) blows TOWARD north (0). A village to the north-east
  // of the fire sits at a bearing of roughly 45-60 degrees off due north.
  const fire = { lat: 36.0, lon: 5.0 };
  const villageNortheast = { lat: 36.05, lon: 5.107 }; // bearing from fire ~= 60 degrees
  const windDirectionFromDeg = 180;

  const result = classifyExposure(fire, villageNortheast, windDirectionFromDeg);
  assert.equal(result.relation, 'marginal');
});
