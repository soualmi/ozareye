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

// overpass-api.de intermittently resolves to AAAA records only from this VPS,
// which has no IPv6 route: Node then picks the v6 address and every lookup dies
// as a bare "fetch failed" at connection level. Node 22 defaults to
// `verbatim` resolution order, so this pins the process to A records first.
// Process-wide and idempotent; callers just say it early.
import dns from 'node:dns';

let applied = false;

export function preferIpv4(): void {
  if (applied) return;
  applied = true;
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // Non-Node runtime, or a Node build without the setter — the caller's own
    // fail-soft path already covers a failed lookup.
  }
}
