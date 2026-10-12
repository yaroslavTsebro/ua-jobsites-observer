// Prints chat ids of everyone who recently wrote to the bot.
// Usage: write any message to your bot in Telegram, then `npm run chat-id`.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('Сначала укажи TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}

const data = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).json();
if (!data.ok) {
  console.error('Telegram:', data.description);
  process.exit(1);
}

const chats = new Map();
for (const u of data.result) {
  const chat = (u.message || u.channel_post || u.my_chat_member)?.chat;
  if (chat) chats.set(chat.id, chat.username || chat.title || chat.first_name);
}

if (!chats.size) console.log('Нет сообщений. Напиши боту что-нибудь в Telegram и запусти снова.');
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);
