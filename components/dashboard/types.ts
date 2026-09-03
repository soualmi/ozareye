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
  evidenceShort: string[];
  selection: { village: VillageExposure; isProximity: boolean }[];
  disclaimer: string;
  landUseContext?: LandUseContext;
  landUseSiteName?: string;
  industrialNote?: string;
};
