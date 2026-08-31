// Mirrors the JSON shapes returned by /api/dashboard/events, /history, /villages.
export type VillageBase = { osm_id: string; name: string; name_ar: string | null; lat: number; lon: number; place: string; wilaya: string };

export type VillageExposure = VillageBase & { distanceKm: number; relation: 'downwind' | 'marginal' | 'upwind'; etaHours?: number };

export type DashboardEvent = {
  id: string;
  latitude: number; longitude: number;
  wilaya: string | null;
  status: 'observation' | 'corroborated' | 'urgent';
  score: number;
  maxFrp: number; instrument: string; satellite: string;
  detectedAtIso: string; detectedAtAlgiers: string;
  windKph?: number; windDirectionFromDeg?: number;
  evidenceShort: string[];
  selection: { village: VillageExposure; isProximity: boolean }[];
  telegramText: string;
};
