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
