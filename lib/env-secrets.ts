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

// Server-side .env.local read/write for the three secrets the /setup screen
// collects. Deliberately narrow: it can only tell a caller WHICH of the three
// known keys are present (booleans), and can only WRITE whole new values for
// them — it never returns a value, never logs one, and has no "read the
// current value" function at all, so there is no code path that could leak
// one back to the client.
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), '.env.local');
export const SECRET_KEYS = ['FIRMS_MAP_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;
export type SecretKey = typeof SECRET_KEYS[number];

function readLines(): string[] {
  try { return fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); } catch { return []; }
}

function parseValue(lines: string[], key: SecretKey): string {
  const line = lines.find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
}

// Read from disk, not process.env — process.env was populated once at server
// startup and won't reflect a save made through this same request/response
// cycle, but the file on disk always does.
export function secretsConfigured(): Record<SecretKey, boolean> {
  const lines = readLines();
  return Object.fromEntries(SECRET_KEYS.map(key => [key, parseValue(lines, key).trim().length > 0])) as Record<SecretKey, boolean>;
}

// Upserts only the keys present in `values` (a key absent from the object is
// left untouched — this lets the form save one field at a time). Empty
// strings are treated as "clear this key" so the form can also be used to
// remove a bad value. Preserves every other line in the file (comments,
// other vars) exactly as-is.
export function writeSecrets(values: Partial<Record<SecretKey, string>>): void {
  const lines = readLines().filter(l => l.length > 0 || l === '');
  const hasTrailingContent = lines.length > 0;
  const kept = hasTrailingContent && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  for (const key of SECRET_KEYS) {
    if (!(key in values)) continue;
    const value = (values[key] ?? '').trim();
    const lineIndex = kept.findIndex(l => l.startsWith(`${key}=`));
    const newLine = `${key}=${value}`;
    if (lineIndex >= 0) kept[lineIndex] = newLine;
    else kept.push(newLine);
  }

  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, kept.join('\n') + '\n', { mode: 0o600 });
}
