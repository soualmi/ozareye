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

// Per-wilaya Telegram destinations. A nationwide feed in one channel is
// unreadable in peak season (dozens of fires/day) — each wilaya should get its
// own channel once one exists for it. Anything not listed here falls back to
// the default TELEGRAM_CHAT_ID from .env.local, so no wilaya is ever silently
// dropped just because it doesn't have a dedicated channel yet.
//
// To add a wilaya's own channel:
//   1. Create a Telegram channel/group and add the bot as admin.
//   2. Send any message in it, then call
//      https://api.telegram.org/bot<TOKEN>/getUpdates to read its chat_id.
//   3. Add an entry below: 'Wilaya Name': 'chat_id'. The wilaya name must match
//      the `name` property in data/wilayas.geojson exactly (e.g. 'Béjaïa').
export const WILAYA_CHAT_IDS: Record<string, string> = {
  // 'Béjaïa': '-100XXXXXXXXXX',
};

export function chatIdForWilaya(wilaya: string | null, defaultChatId: string): string {
  return (wilaya && WILAYA_CHAT_IDS[wilaya]) || defaultChatId;
}
