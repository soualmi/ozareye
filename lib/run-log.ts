// Algérie Feux Alerte
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

import fs from 'node:fs';
import path from 'node:path';

const LOG_PATH = path.join(process.cwd(), 'run.log');
const MAX_BYTES = 5 * 1024 * 1024;

// One JSON line per monitor run. Logging must never break the run itself, so
// every failure here is swallowed.
export function appendRunLog(entry: Record<string, unknown>) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) fs.truncateSync(LOG_PATH, 0);
    fs.appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* never let logging break the run */ }
}
