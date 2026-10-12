import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3777;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const TG_API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const KEEP_DAYS = 45;

// state.seen: { [jobId]: firstSeenISO }
// state.pages: { [pageUrl]: true } — pages that already had a first pass. Jobs without
// a recognizable date are only reported from pages that were seen before, so the
// first run does not flood the chat with the whole list.
// state.enabled: monitoring on/off — switched from the popup or from Telegram.
// state.jobs: { [key]: { title, url, site, company, sentAt, status } } — vacancies sent to
// Telegram; status is 'new' until one of the buttons under the message is pressed.
let state = { seen: {}, pages: {}, jobs: {}, enabled: true, lastCheckAt: null };

async function loadState() {
  try {
    state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) };
  } catch {}
}

async function saveState() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const [id, ts] of Object.entries(state.seen)) if (Date.parse(ts) < cutoff) delete state.seen[id];
  for (const [key, j] of Object.entries(state.jobs)) if (Date.parse(j.sentAt) < cutoff) delete state.jobs[key];
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
  await fs.rename(STATE_FILE + '.tmp', STATE_FILE);
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function tg(method, body) {
  if (!TOKEN || !CHAT_ID) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы в .env');
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, data;
    try {
      res = await fetch(`${TG_API}/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, ...body }),
        signal: AbortSignal.timeout(15000),
      });
      data = await res.json();
    } catch (e) {
      // network hiccup (ECONNRESET, timeout) — retry with a growing pause
      console.warn(`Telegram недоступен (${e.cause?.code || e.message}), повтор ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (data.ok) return data.result;
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, (data.parameters?.retry_after ?? 3) * 1000));
      continue;
    }
    throw new Error(`Telegram: ${data.description}`);
  }
  throw new Error('Telegram: too many retries');
}

const sendText = (text) => tg('sendMessage', { text, parse_mode: 'HTML', disable_web_page_preview: true });

// One vacancy = one message: title + link (+ company / date on a muted line).
function jobMessage(icon, site, job) {
  const meta = [site, job.company, job.dateText].filter(Boolean).join(' · ');
  return `${icon} <b>${esc(job.title)}</b>\n${esc(job.url)}${meta ? `\n<i>${esc(meta)}</i>` : ''}`;
}

const testLabel = (page) => {
  try {
    const u = new URL(page);
    return (u.hostname.replace(/^www\./, '') + u.pathname + u.search).slice(0, 120);
  } catch {
    return page;
  }
};

async function handleTestJob(payload) {
  await saveDebug(payload);
  const { page, site, found, job, error } = payload;
  const where = `<i>${esc(testLabel(page))}</i>`;
  if (error) await sendText(`🧪 ❌ ${where}\nОшибка: ${esc(error)}`);
  else if (!job) await sendText(`🧪 ⚠️ ${where}\nВакансий не найдено — нужно править парсер для ${esc(site)}`);
  else await sendText(`${jobMessage('🧪', site, job)}\n${where} — найдено: ${found}`);
  console.log(`[test] ${site}: найдено ${found}${job ? `, отправлено «${job.title}»` : ''}${error ? `, ошибка: ${error}` : ''}`);
  return { ok: true };
}

async function saveDebug(payload) {
  const dir = path.join(path.dirname(STATE_FILE), 'debug');
  const site = String(payload.site).split('/')[0].replace(/[^\w.-]/g, '_');
  const name = `${site}-${createHash('md5').update(payload.page).digest('hex').slice(0, 6)}.json`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 1));
}

async function handleJobs(payload) {
  const { page, site, jobs = [] } = payload;
  await saveDebug(payload);
  const now = new Date();
  const knownPage = Boolean(state.pages[page]);
  const fresh = [];
  const today = jobs.filter((j) => j.postedAt && sameDay(new Date(j.postedAt), now)).length;

  for (const job of jobs) {
    if (!job.id || state.seen[job.id]) continue;
    const isToday = job.postedAt ? sameDay(new Date(job.postedAt), now) : knownPage;
    if (isToday) fresh.push(job);
    else state.seen[job.id] = now.toISOString(); // old or baseline — remember silently
  }

  const sentJobs = [];
  try {
    for (const job of fresh) {
      const key = jobKey(job.id);
      await tg('sendMessage', {
        text: jobMessage('🆕', site, job),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: statusKeyboard(key, 'new'),
      });
      state.seen[job.id] = now.toISOString();
      state.jobs[key] = { title: job.title, url: job.url, site, company: job.company, sentAt: now.toISOString(), status: 'new' };
      sentJobs.push({ title: job.title, url: job.url });
      await new Promise((r) => setTimeout(r, 400)); // stay under Telegram's per-chat rate limit
    }
    state.pages[page] = true;
    state.lastCheckAt = now.toISOString();
  } finally {
    await saveState();
  }

  console.log(`[${now.toLocaleTimeString()}] ${site}: ${jobs.length} на странице, сегодня ${today}, отправлено ${fresh.length}`);
  return { found: jobs.length, today, sent: sentJobs.length, sentJobs };
}

// ---------- per-vacancy status buttons ----------

// callback_data is limited to 64 bytes, so jobs are addressed by a short hash of their url
const jobKey = (id) => createHash('md5').update(id).digest('hex').slice(0, 12);

const STATUSES = {
  viewed: '👀 Просмотрел',
  applied: '✅ Аплай',
  skip: '👎 Не то',
};

const statusKeyboard = (key, current) => ({
  inline_keyboard: [
    Object.entries(STATUSES).map(([st, label]) => ({
      text: st === current ? `✓ ${label}` : label,
      callback_data: `st:${st}:${key}`,
    })),
  ],
});

function stats() {
  const all = Object.values(state.jobs);
  const count = (st) => all.filter((j) => j.status === st).length;
  const unread = all.filter((j) => j.status === 'new').sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return {
    unread: unread.length,
    viewed: count('viewed'),
    applied: count('applied'),
    skip: count('skip'),
    unreadJobs: unread.slice(0, 30).map(({ title, url, site, company, sentAt }) => ({ title, url, site, company, sentAt })),
  };
}

async function handleStatusButton({ id, data, message }) {
  const [, st, key] = data.split(':');
  const job = state.jobs[key];
  if (!job || !STATUSES[st]) {
    await tg('answerCallbackQuery', { callback_query_id: id, text: 'Вакансия уже не отслеживается' });
    return;
  }
  job.status = st;
  job.statusAt = new Date().toISOString();
  await saveState();
  console.log(`${STATUSES[st]}: ${job.title}`);
  await tg('answerCallbackQuery', { callback_query_id: id, text: `${STATUSES[st]} · непрочитанных: ${stats().unread}` });
  await tg('editMessageReplyMarkup', { message_id: message.message_id, reply_markup: statusKeyboard(key, st) }).catch(() => {});
}

// ---------- on/off switch (popup + Telegram) ----------

const toggleKeyboard = () => ({
  inline_keyboard: [
    [
      state.enabled
        ? { text: '⏸ Выключить мониторинг', callback_data: 'off' }
        : { text: '▶ Включить мониторинг', callback_data: 'on' },
      { text: '🔄 Статус', callback_data: 'status' },
    ],
  ],
});

function statusText() {
  const last = state.lastCheckAt ? new Date(state.lastCheckAt).toLocaleString('uk-UA') : 'ещё не было';
  return `${state.enabled ? '🟢 Мониторинг <b>включён</b>' : '⏸ Мониторинг <b>выключен</b>'}\nПоследняя проверка: ${last}`;
}

const sendStatus = (prefix = '') =>
  tg('sendMessage', { text: prefix + statusText(), parse_mode: 'HTML', reply_markup: toggleKeyboard() });

async function setEnabled(enabled, source) {
  const changed = state.enabled !== enabled;
  state.enabled = enabled;
  await saveState();
  console.log(`Мониторинг ${enabled ? 'включён' : 'выключен'} (${source})`);
  return changed;
}

async function handleTelegramUpdate(u) {
  const chatId = String(u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? '');
  if (chatId !== String(CHAT_ID)) return; // only the owner controls the bot

  if (u.callback_query?.data?.startsWith('st:')) return handleStatusButton(u.callback_query);

  if (u.callback_query) {
    const { id, data, message } = u.callback_query;
    if (data === 'on' || data === 'off') await setEnabled(data === 'on', 'telegram');
    await tg('answerCallbackQuery', { callback_query_id: id, text: state.enabled ? 'Включено' : 'Выключено' });
    await tg('editMessageText', {
      message_id: message.message_id,
      text: statusText(),
      parse_mode: 'HTML',
      reply_markup: toggleKeyboard(),
    }).catch(() => {}); // "message is not modified" is fine
    return;
  }

  const cmd = (u.message?.text || '').trim().split(/[\s@]/)[0].toLowerCase();
  if (cmd === '/on') {
    await setEnabled(true, 'telegram');
    await sendStatus();
  } else if (cmd === '/off') {
    await setEnabled(false, 'telegram');
    await sendStatus();
  } else if (cmd === '/status' || cmd === '/start' || cmd === '/menu') {
    await sendStatus();
  }
}

async function pollTelegram() {
  if (!TOKEN || !CHAT_ID) return;
  await tg('setMyCommands', {
    commands: [
      { command: 'status', description: 'Статус и кнопка вкл/выкл' },
      { command: 'on', description: 'Включить мониторинг' },
      { command: 'off', description: 'Выключить мониторинг' },
    ],
  }).catch((e) => console.warn('setMyCommands:', e.message));

  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`${TG_API}/bot${TOKEN}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }),
        signal: AbortSignal.timeout(65000),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      for (const u of data.result) {
        offset = u.update_id + 1;
        await handleTelegramUpdate(u).catch((e) => console.error('Telegram update:', e.message));
      }
    } catch (e) {
      console.warn('getUpdates:', e.cause?.code || e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'POST' && req.url === '/jobs') return reply(200, await handleJobs(JSON.parse(await readBody(req))));
    if (req.method === 'POST' && req.url === '/test') {
      await tg('sendMessage', { text: '✅ Job Observer подключён' });
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/test-job') return reply(200, await handleTestJob(JSON.parse(await readBody(req))));
    if (req.method === 'POST' && req.url === '/test-start') {
      const { tabs } = JSON.parse(await readBody(req));
      await sendText(`🧪 <b>Тест запущен</b> — вкладок со списками: ${tabs}`);
      return reply(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/test-end') {
      const s = JSON.parse(await readBody(req));
      await sendText(`🧪 <b>Тест завершён</b>\nвкладок: ${s.tabs}, работают: ${s.ok}, с проблемами: ${s.failed}`);
      return reply(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method === 'POST' && req.url === '/snapshot') {
      const { page, html } = JSON.parse(await readBody(req));
      const host = new URL(page).hostname.replace(/^www\./, '');
      const file = `${host}-${createHash('md5').update(page).digest('hex').slice(0, 6)}.html`;
      const dir = path.join(DATA_DIR, 'snapshots');
      await fs.mkdir(dir, { recursive: true });
      // first line keeps the original URL so tests know where the page "lives"
      await fs.writeFile(path.join(dir, file), `<!-- ${page} -->\n${html}`);
      console.log(`📸 ${file} (${Math.round(html.length / 1024)} КБ)`);
      return reply(200, { file });
    }
    if (req.method === 'GET' && req.url === '/stats') return reply(200, stats());
    if (req.method === 'GET' && req.url === '/state') return reply(200, { enabled: state.enabled, lastCheckAt: state.lastCheckAt });
    if (req.method === 'POST' && req.url === '/state') {
      const { enabled } = JSON.parse(await readBody(req));
      if (await setEnabled(Boolean(enabled), 'browser')) await sendStatus('Переключено из браузера\n').catch(() => {});
      return reply(200, { enabled: state.enabled });
    }
    reply(404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    reply(500, { error: String(e.message || e) });
  }
});

await loadState();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Job Observer server: http://localhost:${PORT}`);
  if (!TOKEN || !CHAT_ID) console.warn('⚠ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы — см. README');
  console.log(`Мониторинг: ${state.enabled ? 'включён' : 'выключен'}`);
});
pollTelegram();
