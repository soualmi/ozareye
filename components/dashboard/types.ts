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

// Mirrors the JSON shapes returned by /api/dashboard/events, /history, /villages.
export type VillageBase = { osm_id: string; name: string; name_ar: string | null; 'name:fr'?: string | null; lat: number; lon: number; place: string; wilaya: string };

export type VillageExposure = VillageBase & { distanceKm: number; relation: 'downwind' | 'marginal' | 'upwind'; etaHours?: number };

export type PassInfo = { satellite: string; instrument: string; acquiredAt: string; acquiredAtAlgiers: string };

export type LandUseContext = 'industrial' | 'natural' | 'unknown';

// Per-source watchdog state, as sent by /api/dashboard/events.
export type SourceStatus = { source: string; name: string; ok: boolean; lastSuccessAt: string | null; downSince: string | null };

export type DashboardEvent = {
  id: string;
  latitude: number; longitude: number;
  wilaya: string | null;
  status: 'observation' | 'corroborated' | 'urgent';
  score: number;
  maxFrp: number; instrument: string; satellite: string;
  detectedAtIso: string; detectedAtAlgiers: string; ageMinutes: number;
  windKph?: number; windDirectionFromDeg?: number; humidity?: number;
  passCount: number; maxPixelsInSinglePass: number;
  confidenceLabel: string; magnitude: string;
  sourceStatusLine: string;
  passes: PassInfo[];
  evidenceLine: string;
  selection: { village: VillageExposure; isProximity: boolean }[];
  disclaimer: string;
  credits: string;
  landUseContext?: LandUseContext;
  landUseSiteName?: string;
  // Real OSM forest cover (landuse=forest, natural=wood) at this event's
  // centroid — see lib/forestcover.ts. Absent means not yet looked up;
  // `false` means the local index was checked and found no match (or the
  // index itself is missing — same fail-soft "false" either way).
  inForest?: boolean;
  // Advisory fire-signature likelihood (lib/firesignature.ts) — a
  // plain-language label + score, and its own honesty caveat (real
  // current reference-set size and tier breakdown). Absent when the
  // event has no real-FRP detection yet to compare (Meteosat-only).
  fireLikelihoodLine?: string;
  fireLikelihoodCaveat?: string;
  title: string;
  industrialLeadLine?: string;
  // Meteosat/SLSTR fusion: 'meteosat' means the position is a
  // ~3km-uncertainty geostationary pixel, never corroborated by a polar
  // overpass; 'slstr' means a ~1km-uncertainty SLSTR (also polar, like
  // VIIRS) pixel, not yet corroborated by VIIRS specifically (see
  // lib/fire-monitor.ts's locked fusion rules). geoTracked is a different
  // situation — a VIIRS-confirmed fire ALSO getting Meteosat's ~10min revisit.
  positionSource: 'viirs' | 'meteosat' | 'slstr';
  positionUncertaintyKm?: number;
  geoTracked: boolean;
  // Nearest caserne (lib/firestation.ts, local OSM index). All three absent
  // when the index didn't resolve — the line is simply not rendered. Phone
  // is the station's own OSM tag or null; the UI falls back to the generic
  // Protection Civile number so the link is always callable.
  nearestStationLine?: string;
  nearestStationPhone?: string | null;
  nearestStationDistanceKm?: number;
  // One plain sentence for a first-time visitor (lib/dashboard-view.ts
  // summaryLine); absent for industrial events, whose industrialLeadLine
  // already plays that role.
  summaryLine?: string;
};
