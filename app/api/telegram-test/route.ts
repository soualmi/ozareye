export async function POST() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return Response.json({error:'Telegram non configuré'}, {status:503});
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:'✅ Algérie Feux Alerte est connecté. Les alertes contiendront toujours la source, l’heure, les coordonnées et le score de corroboration.'})});
  return Response.json({ok:response.ok}, {status:response.ok?200:502});
}
