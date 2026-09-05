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

// Sentinel-2 dNBR burn-scar verification, real imagery from Microsoft
// Planetary Computer (anonymous STAC + SAS; see scripts/burn-scar-verify.py's
// header for the access decision and band/threshold choices).
//
// This is NOT a detection source like lib/slstr.ts / lib/meteosat.ts: it runs
// days AFTER an event, asks "does an optical burn scar actually appear on the
// ground?", and stores the answer in burn_scar_verification. It is not wired
// into app/api/monitor/route.ts yet — nothing calls verifyBurnScar() in
// production until Sid has reviewed the access method.
//
// Same subprocess + fail-soft contract as lib/slstr.ts: the python script is
// spawned per event, prints one JSON row, and ANY failure here (missing
// interpreter, numpy absent, stub not implemented, bad JSON) is caught,
// logged, and turned into `null` — it must never throw into a caller.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { upsertBurnScarVerification, type BurnScarVerificationRow } from './database';
import type { FireEvent } from './fire-monitor';

export const BURN_SCAR_SOURCE = 'sentinel2-dnbr';
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'burn-scar-verify.py');
// scripts/burn-scar-verify.py reserves exit 3 for "quietly unavailable"
// (it was the stub's code before the fetch was wired) — kept distinct from
// a real failure (exit 1) so a watchdog can tell the two apart.
const EXIT_NOT_IMPLEMENTED = 3;

export type BurnScarResult = BurnScarVerificationRow;

type RawRow = {
  event_id: string; pre_date: string | null; post_date: string | null; dnbr_mean: number | null;
  classification: BurnScarVerificationRow['classification'];
  cloud_cover_pre: number | null; cloud_cover_post: number | null;
};

function rawToRow(raw: RawRow, verifiedAt: string): BurnScarVerificationRow {
  return {
    eventId: raw.event_id, preDate: raw.pre_date, postDate: raw.post_date, dnbrMean: raw.dnbr_mean, classification: raw.classification,
    cloudCoverPre: raw.cloud_cover_pre, cloudCoverPost: raw.cloud_cover_post, verifiedAt,
  };
}

// Minimum post-fire wait before a check is even worth attempting — mirrors
// POST_MIN_DAYS in the python script. A caller iterating recent events can
// use this to skip events too fresh to have a post-fire scene.
export const BURN_SCAR_MIN_AGE_DAYS = 3;

export function isOldEnoughForBurnScar(event: Pick<FireEvent, 'firstAcquiredAt'>, now = new Date()): boolean {
  return now.getTime() - new Date(event.firstAcquiredAt).getTime() >= BURN_SCAR_MIN_AGE_DAYS * 86_400_000;
}

export async function verifyBurnScar(event: Pick<FireEvent, 'id' | 'latitude' | 'longitude' | 'firstAcquiredAt'>): Promise<BurnScarResult | null> {
  try {
    // Same test seam as SLSTR_PYTHON_BIN / METEOSAT_PYTHON_BIN — never set in production.
    const pythonBin = process.env.BURNSCAR_PYTHON_BIN || 'python3';
    // --flag=value form so a negative longitude never reads as a flag (see lib/slstr.ts).
    const args = [SCRIPT_PATH, `--event-id=${event.id}`, `--lat=${event.latitude}`, `--lon=${event.longitude}`, `--date=${event.firstAcquiredAt}`];
    const result = spawnSync(pythonBin, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });

    if (result.error) throw result.error;
    if (result.status === EXIT_NOT_IMPLEMENTED) {
      console.log(`source ${BURN_SCAR_SOURCE} (${event.id}): unavailable (Sentinel-2 access not wired yet)`);
      return null;
    }
    if (result.status !== 0) {
      const message = (result.stderr || `python exited with status ${result.status}`).trim().slice(0, 300);
      console.log(`source ${BURN_SCAR_SOURCE} (${event.id}): FAILED (${message})`);
      return null;
    }

    const line = result.stdout.split('\n').map(l => l.trim()).filter(Boolean).pop();
    if (!line) throw new Error('python printed no result row');
    const row = rawToRow(JSON.parse(line) as RawRow, new Date().toISOString());
    await upsertBurnScarVerification(row);
    console.log(`source ${BURN_SCAR_SOURCE} (${event.id}): ${row.classification} (dNBR ${row.dnbrMean ?? 'n/a'}, ${row.preDate ?? '?'} -> ${row.postDate ?? '?'})`);
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`source ${BURN_SCAR_SOURCE} (${event.id}): FAILED (${message})`);
    return null;
  }
}
