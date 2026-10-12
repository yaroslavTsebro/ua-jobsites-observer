// End-to-end test: real Chrome + real extension + real server, fake Telegram, ZERO traffic
// to job sites. Pages are served from saved fixtures through request interception; any
// other request (scripts, images, analytics, anything) is aborted before leaving Chrome.
//
//   npm run e2e
//
// Fixtures: tests/fixtures/*.html and data/snapshots/*.html (📸 button in the popup).
// The first line of every fixture is `<!-- original page url -->`.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { loadFixtures, injectJob, siteOf } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const TG_PORT = 3901;
const APP_PORT = 3902;
const CHAT_ID = '42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny assertion log ----------

const results = [];
function check(name, ok, details = '') {
  results.push({ name, ok, details });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${details ? `  — ${details}` : ''}`);
}
const step = (title) => console.log(`\n▶ ${title}`);

async function waitFor(fn, timeout = 15000, every = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

// ---------- fake Telegram ----------

const tg = { calls: [], messages: [], updates: [], failNext: 0, errorNext: 0, rateLimitNext: 0, nextUpdateId: 1, nextMsgId: 1 };

function startFakeTelegram() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const params = body ? JSON.parse(body) : {};
      const method = req.url.split('/').pop();
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (method === 'getUpdates') {
        await waitFor(() => tg.updates.length, 800, 100);
        return send(200, { ok: true, result: tg.updates.splice(0) });
      }
      if (tg.failNext > 0) {
        tg.failNext--;
        return req.socket.destroy(); // client sees ECONNRESET
      }
      if (tg.rateLimitNext > 0) {
        tg.rateLimitNext--;
        return send(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } });
      }
      if (tg.errorNext > 0) {
        tg.errorNext--;
        return send(400, { ok: false, description: 'Bad Request: simulated' });
      }
      tg.calls.push({ method, params });
      if (method === 'sendMessage') tg.messages.push({ text: params.text, chat_id: params.chat_id, reply_markup: params.reply_markup });
      send(200, { ok: true, result: { message_id: tg.nextMsgId++ } });
    });
    srv.listen(TG_PORT, '127.0.0.1', () => resolve(srv));
  });
}

const pushUpdate = (u) => tg.updates.push({ update_id: tg.nextUpdateId++, ...u });

// ---------- app server ----------

let app = null;
const appLog = [];
async function startApp(dataDir) {
  app = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR: dataDir,
      TELEGRAM_API: `http://127.0.0.1:${TG_PORT}`,
      TELEGRAM_BOT_TOKEN: 'TEST',
      TELEGRAM_CHAT_ID: CHAT_ID,
    },
  });
  app.stdout.on('data', (d) => appLog.push(String(d)));
  app.stderr.on('data', (d) => appLog.push(String(d)));
  const up = await waitFor(() => fetch(`http://127.0.0.1:${APP_PORT}/health`).then((r) => r.ok).catch(() => false), 10000);
  if (!up) throw new Error('app server did not start:\n' + appLog.join(''));
}
async function stopApp() {
  if (!app) return;
  const p = new Promise((r) => app.once('exit', r));
  app.kill();
  await p;
  app = null;
}
const appState = async (dataDir) => JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));

// ---------- main ----------

const pages = await loadFixtures();
if (!pages.size) throw new Error('no fixtures found');

// Same DOU page under a second URL — to check that a job shown on two tabs is sent once.
const douUrl = [...pages.keys()].find((u) => u.includes('jobs.dou.ua'));
const douAlias = douUrl && douUrl.replace(/exp=[^&]*/, 'exp=3-5') + (douUrl.includes('exp=') ? '' : '&exp=3-5');
if (douUrl && !pages.has(douAlias)) pages.set(douAlias, pages.get(douUrl));
// Minimal LinkedIn page if there's no snapshot — enough to test the per-site rate limit.
const liUrl = [...pages.keys()].find((u) => u.includes('linkedin.com')) || 'https://www.linkedin.com/jobs/search-results/?keywords=node.js';
const liPlaceholder = !pages.has(liUrl);
if (liPlaceholder) pages.set(liUrl, '<html><body><main>LinkedIn placeholder</main></body></html>');

const served = new Map(pages); // url -> html currently served (scenarios mutate it)
const traffic = { served: 0, aborted: 0, hosts: new Set(), leaked: [] };

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-observer-e2e-'));
const tgServer = await startFakeTelegram();
await startApp(dataDir);

console.log(`Fixtures (${served.size}):`);
for (const u of served.keys()) console.log('  ' + u);

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run', '--no-default-browser-check'],
});

let exitCode = 0;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  await sw.evaluate(
    (server) => chrome.storage.local.set({ server, safeMode: false, intervalMin: 1000, settleOverrideMs: 200 }),
    `http://localhost:${APP_PORT}`,
  );
  await sw.evaluate(() => chrome.alarms.clearAll());

  const tabs = new Map(); // url -> puppeteer page
  for (const url of served.keys()) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (u.startsWith('data:') || u.startsWith('chrome-extension:')) return req.continue();
      try {
        traffic.hosts.add(new URL(u).hostname);
      } catch {}
      if (req.isNavigationRequest() && served.has(u)) {
        traffic.served++;
        return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: served.get(u) });
      }
      traffic.aborted++;
      req.abort('blockedbyclient');
    });
    page.on('requestfinished', (req) => {
      const r = req.response();
      // any response that did not come from our respond() would be real network traffic
      if (r && !r.fromServiceWorker() && !req.url().startsWith('data:') && !served.has(req.url()) && !req.url().startsWith('chrome-extension:'))
        traffic.leaked.push(req.url());
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    tabs.set(url, page);
  }

  const run = (mode = 'normal') => sw.evaluate((m) => runCheck(m), mode);
  const lastLog = () => sw.evaluate(async () => (await chrome.storage.local.get('log')).log || []);
  const jobMsgs = () => tg.messages.filter((m) => m.text.startsWith('🆕'));
  const reset = () => (tg.messages.length = 0);

  // 1 ------------------------------------------------------------------
  step('1. Первый запуск: старые вакансии не отправляются, вкладки запоминаются');
  reset();
  let sum = await run();
  const logs = await lastLog();
  for (const url of served.keys()) {
    const line = logs.find((l) => l.text.includes(new URL(url).hostname.replace(/^www\./, '')) && l.text.includes('найдено вакансий'));
    if (url === liUrl && liPlaceholder) continue;
    const n = Number(line?.text.match(/найдено вакансий: (\d+)/)?.[1] ?? 0);
    check(`парсер: ${new URL(url).hostname}${new URL(url).search.slice(0, 40)}`, n > 0, `${n} вакансий`);
  }
  // data quality per page — from the payloads the server stored
  for (const f of await fs.readdir(path.join(dataDir, 'debug'))) {
    const { page, jobs = [] } = JSON.parse(await fs.readFile(path.join(dataDir, 'debug', f), 'utf8'));
    if (!jobs.length) continue;
    const label = new URL(page).hostname.replace(/^www\./, '') + new URL(page).search.slice(0, 30);
    const badUrl = jobs.filter((j) => !/^https:\/\/[^/]+\/.+/.test(j.url));
    const badTitle = jobs.filter((j) => !j.title || j.title.length < 3 || j.title.length > 200);
    const salary = jobs.filter((j) => /грн|\$|€|uah/i.test(j.company));
    const dated = jobs.filter((j) => j.postedAt).length;
    check(
      `данные: ${label}`,
      !badUrl.length && !badTitle.length && !salary.length && dated / jobs.length >= 0.8,
      `дата у ${dated}/${jobs.length}; пример: «${jobs[0].title}» · ${jobs[0].company || '—'} · ${jobs[0].dateText || '—'}`,
    );
  }
  let st = await appState(dataDir);
  check('все страницы помечены как известные', Object.keys(st.pages).length >= served.size - 1, `${Object.keys(st.pages).length}`);
  // Snapshots are real pages: some vacancies on them may genuinely be from today.
  const todayIds = new Set();
  for (const f of await fs.readdir(path.join(dataDir, 'debug'))) {
    const { jobs = [] } = JSON.parse(await fs.readFile(path.join(dataDir, 'debug', f), 'utf8'));
    for (const j of jobs) if (j.postedAt && new Date(j.postedAt).toDateString() === new Date().toDateString()) todayIds.add(j.url);
  }
  const sentUrls = jobMsgs().map((m) => m.text.split('\n')[1]);
  check(
    'отправлены ровно сегодняшние вакансии, старые — нет',
    sentUrls.length === todayIds.size && sentUrls.every((u) => todayIds.has(u)),
    `сегодняшних на страницах: ${todayIds.size}, отправлено: ${sentUrls.length}`,
  );

  // 2 ------------------------------------------------------------------
  step('2. Появились новые вакансии с сегодняшней датой');
  reset();
  const injected = [];
  for (const url of [...served.keys()].filter((u) => !(u === liUrl && liPlaceholder) && u !== douAlias)) {
    const { html, title } = injectJob(served.get(url), url, { tag: siteOf(url) });
    served.set(url, html);
    injected.push({ url, title });
  }
  // the same new DOU job also shows up on the second DOU tab
  if (douAlias) served.set(douAlias, served.get(douUrl));
  sum = await run();
  for (const { url, title } of injected) {
    const msgs = jobMsgs().filter((m) => m.text.includes(title));
    check(`новая вакансия ${siteOf(url)} пришла ровно 1 раз`, msgs.length === 1, `${msgs.length} шт.`);
    const m = msgs[0]?.text || '';
    check(`  формат: заголовок + ссылка`, /<b>E2E .+<\/b>\nhttps?:\/\/\S+/.test(m), m.split('\n').slice(0, 2).join(' | '));
  }
  check('лишних сообщений нет', jobMsgs().length === injected.length, `${jobMsgs().length} vs ${injected.length}`);
  const foundLog = (await lastLog()).filter((l) => l.level === 'found');
  check('в логе расширения каждая новая вакансия подсвечена', foundLog.length === injected.length, `${foundLog.length} строк`);
  check(
    'под каждой вакансией кнопки 👀 / ✅ / 👎',
    jobMsgs().every((m) => m.reply_markup?.inline_keyboard?.[0]?.map((b) => b.callback_data.split(':')[1]).join() === 'viewed,applied,skip'),
  );
  check('все сообщения в нужный чат', tg.messages.every((m) => String(m.chat_id) === CHAT_ID));

  // 3 ------------------------------------------------------------------
  step('3. Повторная проверка без изменений — ничего не шлётся');
  reset();
  await run();
  check('повторов нет', jobMsgs().length === 0, `${jobMsgs().length}`);

  // 4 ------------------------------------------------------------------
  step('4. Новая вакансия без даты на уже известной странице');
  reset();
  const noDate = injectJob(served.get(douUrl), douUrl, { dated: false, tag: 'nodate' });
  served.set(douUrl, noDate.html);
  await run();
  check('вакансия без даты отправлена 1 раз', jobMsgs().filter((m) => m.text.includes(noDate.title)).length === 1);

  // 5 ------------------------------------------------------------------
  step('5. Сеть до Telegram рвётся (2× ECONNRESET) и 429 — сервер повторяет');
  reset();
  const flaky = injectJob(served.get(douUrl), douUrl, { tag: 'flaky' });
  served.set(douUrl, flaky.html);
  tg.failNext = 2;
  tg.rateLimitNext = 1;
  await run();
  check('после сбоев вакансия пришла ровно 1 раз', jobMsgs().filter((m) => m.text.includes(flaky.title)).length === 1);

  // 6 ------------------------------------------------------------------
  step('6. Telegram отклонил сообщение — вакансия не теряется, уходит в следующий раз');
  reset();
  const rejected = injectJob(served.get(douUrl), douUrl, { tag: 'rejected' });
  served.set(douUrl, rejected.html);
  tg.errorNext = 1;
  await run();
  const errLogged = (await lastLog()).some((l) => l.level === 'error' && /simulated/.test(l.text));
  check('ошибка видна в логе расширения', errLogged);
  check('в этот раз не дошла', jobMsgs().filter((m) => m.text.includes(rejected.title)).length === 0);
  await run();
  check('при следующей проверке пришла 1 раз', jobMsgs().filter((m) => m.text.includes(rejected.title)).length === 1);

  // 7 ------------------------------------------------------------------
  step('7. Перезапуск сервера — память об отправленном сохраняется');
  reset();
  await stopApp();
  await startApp(dataDir);
  await run();
  check('после рестарта повторов нет', jobMsgs().length === 0, `${jobMsgs().length}`);

  // 8 ------------------------------------------------------------------
  step('8. Выключение из Telegram, включение из браузера');
  reset();
  pushUpdate({ callback_query: { id: 'cb1', data: 'off', message: { message_id: 1, chat: { id: Number(CHAT_ID) } } } });
  const off = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${APP_PORT}/state`)).json()).enabled === false, 5000);
  check('кнопка в TG выключила мониторинг', Boolean(off));
  const before = traffic.served;
  const tick = await sw.evaluate(() => onAlarmTick());
  check('автопроверка пропущена, вкладки не перезагружались', tick?.skipped === 'disabled' && traffic.served === before);
  check('на значке OFF', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === 'OFF');

  pushUpdate({ message: { message_id: 5, chat: { id: 777 }, text: '/on' } });
  await sleep(1500);
  check('чужой чат не может включить', (await (await fetch(`http://127.0.0.1:${APP_PORT}/state`)).json()).enabled === false);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('toggle').textContent.includes('выключен'), { timeout: 8000 });
  await popup.click('#toggle');
  const on = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${APP_PORT}/state`)).json()).enabled === true, 5000);
  check('кнопка в попапе включила мониторинг', Boolean(on));
  check('в TG пришло «Переключено из браузера»', Boolean(await waitFor(() => tg.messages.some((m) => m.text.includes('Переключено из браузера')), 5000)));
  await popup.close();

  pushUpdate({ message: { message_id: 6, chat: { id: Number(CHAT_ID) }, text: '/status' } });
  check('/status отвечает', Boolean(await waitFor(() => tg.messages.some((m) => m.text.includes('Мониторинг <b>включён</b>')), 5000)));

  // 9 ------------------------------------------------------------------
  step('9. Режим «🧪 Тест»');
  reset();
  const seenBefore = Object.keys((await appState(dataDir)).seen).length;
  await run('test');
  const testMsgs = tg.messages.filter((m) => m.text.startsWith('🧪'));
  check('сообщения: старт + по одному на вкладку + итог', testMsgs.length === served.size + 2, `${testMsgs.length} (вкладок ${served.size})`);
  check('тест не трогает память отправленного', Object.keys((await appState(dataDir)).seen).length === seenBefore);
  reset();
  await run();
  check('после теста обычная проверка ничего не дублирует', jobMsgs().length === 0);

  // 9b -----------------------------------------------------------------
  step('9b. Кнопки под вакансией и счётчик непрочитанных');
  const stats = () => fetch(`http://127.0.0.1:${APP_PORT}/stats`).then((r) => r.json());
  const s0 = await stats();
  check('все отправленные вакансии числятся непрочитанными', s0.unread > 0 && s0.viewed + s0.applied + s0.skip === 0, `непрочитанных: ${s0.unread}`);
  await sw.evaluate(() => refreshBadge());
  check('на значке число непрочитанных', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === String(s0.unread));

  const press = (cb, msgId = 100) =>
    pushUpdate({ callback_query: { id: `cb-${cb}`, data: cb, message: { message_id: msgId, chat: { id: Number(CHAT_ID) } } } });
  const sentWithButtons = tg.calls.filter((c) => c.method === 'sendMessage' && c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('st:'));
  const [btnViewed, btnApplied] = sentWithButtons[0].params.reply_markup.inline_keyboard[0].map((b) => b.callback_data);
  press(btnApplied);
  const s1 = await waitFor(async () => {
    const s = await stats();
    return s.applied === 1 ? s : null;
  }, 5000);
  check('«✅ Аплай» — непрочитанных стало на 1 меньше', s1?.unread === s0.unread - 1, `${s0.unread} → ${s1?.unread}`);
  const edit = tg.calls.findLast((c) => c.method === 'editMessageReplyMarkup');
  check('выбранная кнопка помечена ✓', edit?.params.reply_markup.inline_keyboard[0].some((b) => b.text === '✓ ✅ Аплай'));
  check('всплывающий ответ со счётчиком', tg.calls.some((c) => c.method === 'answerCallbackQuery' && /непрочитанных: \d+/.test(c.params.text)));
  press(btnViewed);
  const s2 = await waitFor(async () => {
    const s = await stats();
    return s.viewed === 1 ? s : null;
  }, 5000);
  check('передумал: «👀» вместо «✅», счётчик не уменьшился второй раз', s2?.applied === 0 && s2?.unread === s1?.unread);
  await sw.evaluate(() => refreshBadge());
  check('значок обновился', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === String(s2?.unread || ''));
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  const shown = await pop.waitForFunction((n) => document.getElementById('unreadCount').textContent === String(n) && document.querySelectorAll('#unreadList li').length === Math.min(n, 30), { timeout: 8000 }, s2?.unread).then(() => true, () => false);
  check('в попапе счётчик и список непрочитанных', shown);
  await pop.close();

  // 10 -----------------------------------------------------------------
  step('10. Безопасный режим: активная вкладка и лимит LinkedIn');
  await sw.evaluate(() => chrome.storage.local.set({ safeMode: true, lastReloads: {} }));
  const front = [...served.keys()].find((u) => u.includes('web3')) || [...served.keys()][0];
  await tabs.get(front).bringToFront();
  await run();
  let l = await lastLog();
  check('активная вкладка не перезагружалась', l.some((x) => x.text.includes('ты сейчас на этой вкладке')));
  check('LinkedIn проверен в первый раз', l.some((x) => x.text.includes('linkedin.com') && x.text.includes('обновляю')));
  await run();
  l = await lastLog();
  check('LinkedIn пропущен при повторе (<30 мин)', l.some((x) => x.text.includes('linkedin.com') && x.text.includes('не чаще раза в 30')));
  await sw.evaluate(() => chrome.storage.local.set({ safeMode: false }));

  // 11 -----------------------------------------------------------------
  step('11. Сервер выключен');
  await stopApp();
  await run();
  check('в логе понятная ошибка', (await lastLog()).some((x) => x.text.includes('недоступен')));
  await startApp(dataDir);

  // traffic ------------------------------------------------------------
  step('Сетевой трафик к сайтам');
  check('ни одного реального ответа из сети', traffic.leaked.length === 0, traffic.leaked.slice(0, 3).join(', '));
  console.log(`  страниц отдано из фикстур: ${traffic.served}, заблокировано запросов: ${traffic.aborted}`);
} catch (e) {
  console.error('\n💥', e);
  exitCode = 1;
} finally {
  await browser.close();
  await stopApp();
  tgServer.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} проверок прошло`);
if (failed.length) {
  console.log('\nЛог сервера:\n' + appLog.join('').slice(-3000));
}
process.exit(failed.length || exitCode ? 1 : 0);
