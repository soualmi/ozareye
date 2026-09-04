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

// Copernicus Sentinel-3 SLSTR Level 2 FRP ingestion — a third detection
// source alongside VIIRS/FIRMS (polar, lib/fire-monitor.ts) and MTG
// (geostationary, lib/meteosat.ts). Unlike MTG_FIR, SLSTR carries a real
// per-detection Fire Radiative Power (MW) — see scripts/slstr-fetch.py's
// module docstring for the product structure this parses. Same shape as
// lib/meteosat.ts throughout: the actual EUMETSAT Data Store access (auth,
// search, download, NetCDF parsing) lives in the python script, run here as
// a subprocess for the same reason (eumdac has no JS equivalent).
//
// Fail-soft by design, same contract as fetchMeteosatSlots()/fetchDetections():
// any failure here is caught, logged, and returns an empty detection list —
// it must never block or slow the VIIRS or Meteosat paths in
// app/api/monitor/route.ts.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getIngestState, setIngestState } from './database';
import { SLSTR_SOURCE, type Detection } from './fire-monitor';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'slstr-fetch.py');
const INGEST_STATE_KEY = 'slstr_since';
// Real measured cadence over Algeria: 4 products/day (2 from S3A, 2 from
// S3B) — a look-back just long enough to not miss the current cron cycle on
// a fresh deployment, not the whole mission history. Wider than Meteosat's
// 20min DEFAULT_LOOKBACK_MIN since SLSTR's own revisit is far less frequent.
const DEFAULT_LOOKBACK_MIN = 6 * 60;

export type SlstrResult = { source: typeof SLSTR_SOURCE; detections: Detection[]; ok: boolean; error?: string };

type RawRow = { lat: number; lon: number; frp_mw: number; uncertainty_mw: number | null; confidence: string; acquired_at: string; satellite: string };

function rowToDetection(row: RawRow): Detection {
  // Unlike Meteosat, this product DOES carry a real per-detection FRP and
  // confidence (see scripts/slstr-fetch.py) — frp/confidence are real
  // readings here, not the "no signal" 0/'' placeholders MTG rows use.
  // uncertaintyMw is the FRP measurement's own uncertainty (MW), separate
  // from radiusKm (position uncertainty, km) — never conflated.
  return {
    latitude: row.lat, longitude: row.lon, acquiredAt: row.acquired_at, satellite: row.satellite, instrument: 'SLSTR',
    confidence: row.confidence, frp: row.frp_mw, uncertaintyMw: row.uncertainty_mw ?? undefined,
  };
}

export async function fetchSlstrPasses(bbox: { west: number; south: number; east: number; north: number }): Promise<SlstrResult> {
  try {
    const since = (await getIngestState(INGEST_STATE_KEY)) ?? new Date(Date.now() - DEFAULT_LOOKBACK_MIN * 60_000).toISOString();
    const bboxStr = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    // Overridable so tests can point at a broken interpreter — same test
    // seam as lib/meteosat.ts's METEOSAT_PYTHON_BIN, never set in production.
    const pythonBin = process.env.SLSTR_PYTHON_BIN || 'python3';
    // --flag=value form, not two separate argv entries — bbox's west value
    // is routinely negative, same reasoning as lib/meteosat.ts. A real
    // product download (NetCDF, not CAP XML) is slower than Meteosat's CAP
    // pull, hence the longer timeout.
    const result = spawnSync(pythonBin, [SCRIPT_PATH, `--since=${since}`, `--bbox=${bboxStr}`], { encoding: 'utf8', timeout: 120_000 });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = (result.stderr || `python exited with status ${result.status}`).trim().slice(0, 300);
      console.log(`source ${SLSTR_SOURCE}: FAILED (${message})`);
      return { source: SLSTR_SOURCE, detections: [], ok: false, error: message };
    }

    const detections: Detection[] = [];
    let cursor: string | null = null;
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed) as RawRow & { _cursor?: string };
      if (row._cursor) { cursor = row._cursor; continue; }
      detections.push(rowToDetection(row));
    }
    // Advances even when a checked product had zero vegetation-fire
    // detections in bbox — see scripts/slstr-fetch.py's cursor-line comment.
    if (cursor) await setIngestState(INGEST_STATE_KEY, cursor);

    console.log(`source ${SLSTR_SOURCE}: ${detections.length} detection(s)`);
    return { source: SLSTR_SOURCE, detections, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`source ${SLSTR_SOURCE}: FAILED (${message})`);
    return { source: SLSTR_SOURCE, detections: [], ok: false, error: message };
  }
}
