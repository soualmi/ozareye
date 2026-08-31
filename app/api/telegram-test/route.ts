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

export async function POST() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return Response.json({error:'Telegram non configuré'}, {status:503});
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:'✅ Algérie Feux Alerte est connecté. Les alertes contiendront toujours la source, l’heure, les coordonnées et le score de corroboration.'})});
  return Response.json({ok:response.ok}, {status:response.ok?200:502});
}
