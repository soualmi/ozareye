// Pure geometry helpers, kept dependency-free so they are trivially unit-testable.

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const rad = Math.PI / 180, dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Compass bearing (0-360, 0=N, 90=E) from point A to point B.
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number) {
  const rad = Math.PI / 180;
  const lat1 = aLat * rad, lat2 = bLat * rad, dLon = (bLon - aLon) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Smallest angle (0-180) between two compass directions.
export function angleDiffDeg(a: number, b: number) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}
