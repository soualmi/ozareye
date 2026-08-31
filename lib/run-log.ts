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
