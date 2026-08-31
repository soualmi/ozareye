import { angleDiffDeg, bearingDeg } from './geo';

export type WindRelation = 'downwind' | 'marginal' | 'upwind';

export const DOWNWIND_MAX_DEG = 45;
export const MARGINAL_MAX_DEG = 75;

/**
 * Open-Meteo's wind_direction_10m is METEOROLOGICAL convention: the direction the
 * wind is blowing FROM (0=from the north, 90=from the east, ...). Smoke/fire travel
 * the opposite way, so the direction it blows TOWARD is +180.
 * Get this backwards and every downwind/upwind classification inverts silently.
 */
export function blowsTowardDeg(windDirectionFromDeg: number): number {
  return (windDirectionFromDeg + 180) % 360;
}

const CARDINALS_FR = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export function cardinalFr(deg: number) {
  return CARDINALS_FR[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * Classifies a village relative to a fire's wind. `fire` and `village` are
 * {lat, lon}. `windDirectionFromDeg` is the raw meteorological reading (FROM).
 */
export function classifyExposure(
  fire: { lat: number; lon: number },
  village: { lat: number; lon: number },
  windDirectionFromDeg: number,
): { relation: WindRelation; bearingFromFireDeg: number; angleFromDownwindDeg: number } {
  const bearingFromFireDeg = bearingDeg(fire.lat, fire.lon, village.lat, village.lon);
  const towardDeg = blowsTowardDeg(windDirectionFromDeg);
  const angleFromDownwindDeg = angleDiffDeg(bearingFromFireDeg, towardDeg);
  const relation: WindRelation =
    angleFromDownwindDeg <= DOWNWIND_MAX_DEG ? 'downwind' :
    angleFromDownwindDeg <= MARGINAL_MAX_DEG ? 'marginal' : 'upwind';
  return { relation, bearingFromFireDeg, angleFromDownwindDeg };
}
