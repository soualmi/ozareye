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

// EUMETSAT MTG Active Fire Monitoring ingestion — a second, geostationary
// detection source alongside the three polar VIIRS/FIRMS feeds (lib/fire-
// monitor.ts). The actual EUMETSAT Data Store access (auth, search,
// download, CAP parsing) lives in scripts/meteosat-fetch.py, run here as a
// subprocess: eumdac is a Python library with no JS equivalent, and shelling
// out to one short-lived process per ~20min cron run is simpler and more
// robust than reimplementing OAuth token/search/download in TypeScript.
//
// Fail-soft by design, same contract as fetchDetections() for VIIRS: any
// failure here (script crash, quota/429, network) is caught, logged, and
// returns an empty detection list — it must never block or slow the VIIRS
// path in app/api/monitor/route.ts.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getIngestState, setIngestState } from './database';
import { MTG_SOURCE, type Detection } from './fire-monitor';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'meteosat-fetch.py');
const INGEST_STATE_KEY = 'meteosat_since';
// A brand-new deployment (or a corrupt/missing ingest_state row) has no
// watermark to resume from — look back just long enough to not miss the
// current cron cycle, not the whole MTG mission history.
const DEFAULT_LOOKBACK_MIN = 20;

export type MeteosatResult = { source: typeof MTG_SOURCE; detections: Detection[]; ok: boolean; error?: string };

type RawRow = { lat: number; lon: number; acquired_at: string; frp_or_intensity: number | null; confidence: string | null };

function rowToDetection(row: RawRow): Detection {
  // This product carries no per-detection FRP or confidence (see
  // scripts/meteosat-fetch.py's module docstring) — frp:0/confidence:''
  // are the same "no signal" values confidenceRank()/scoreEvent() already
  // treat as the bottom rank, not a fabricated reading.
  return { latitude: row.lat, longitude: row.lon, acquiredAt: row.acquired_at, satellite: 'MTI1', instrument: 'FCI', confidence: row.confidence ?? '', frp: row.frp_or_intensity ?? 0 };
}

export async function fetchMeteosatSlots(bbox: { west: number; south: number; east: number; north: number }): Promise<MeteosatResult> {
  try {
    const since = (await getIngestState(INGEST_STATE_KEY)) ?? new Date(Date.now() - DEFAULT_LOOKBACK_MIN * 60_000).toISOString();
    const bboxStr = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    // Overridable so tests can point at a broken interpreter without a
    // module-load-time constant getting in the way — never set in
    // production today, just an escape hatch (and a test seam).
    const pythonBin = process.env.METEOSAT_PYTHON_BIN || 'python3';
    // Sequential, single subprocess, no retry loop here — eumdac already
    // retries 429/5xx internally (per its own docs), and this run's only job
    // is to not hang the whole monitor run if EUMETSAT is slow or down.
    // --since/--bbox use the `--flag=value` form, not two separate argv
    // entries: a bbox's west value is routinely negative ("-2.5,..."), and
    // argparse treats a bare token starting with "-" as another option
    // rather than this one's value unless it's joined with "=".
    const result = spawnSync(pythonBin, [SCRIPT_PATH, `--since=${since}`, `--bbox=${bboxStr}`], { encoding: 'utf8', timeout: 60_000 });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = (result.stderr || `python exited with status ${result.status}`).trim().slice(0, 300);
      console.log(`source ${MTG_SOURCE}: FAILED (${message})`);
      return { source: MTG_SOURCE, detections: [], ok: false, error: message };
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
    // Advances even when a checked product had zero detections in bbox —
    // see scripts/meteosat-fetch.py's cursor-line comment for why that
    // matters (otherwise an empty frame gets re-fetched every run).
    if (cursor) await setIngestState(INGEST_STATE_KEY, cursor);

    console.log(`source ${MTG_SOURCE}: ${detections.length} detection(s)`);
    return { source: MTG_SOURCE, detections, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`source ${MTG_SOURCE}: FAILED (${message})`);
    return { source: MTG_SOURCE, detections: [], ok: false, error: message };
  }
}
