// safeMode: human-like pacing (jittered interval, shuffled tabs, random pauses, per-site
// minimum interval, never reload the tab you are looking at). Only e2e tests turn it off.
const DEFAULTS = { intervalMin: 15, server: 'http://localhost:3777', safeMode: true };
const ALARM = 'job-observer-check';
const LOG_LIMIT = 300;

// Which tabs count as "job list" pages. Single-vacancy pages are ignored.
const LIST_PAGES = [
  { host: /(^|\.)djinni\.co$/, path: /^\/jobs\/?$/ },
  { host: /^jobs\.dou\.ua$/, path: /^\/vacancies\/?$/ },
  { host: /(^|\.)work\.ua$/, path: /^\/(ru\/|en\/)?jobs-[^/]+\/?$/ },
  { host: /(^|\.)robota\.ua$/, path: /^\/(ru\/|en\/)?zapros\// },
  { host: /(^|\.)jobico\.io$/, path: /^\/([a-z]{2}\/)?jobs\/?$/ },
  { host: /(^|\.)web3\.career$/, path: /-jobs\/?$/ },
  { host: /(^|\.)linkedin\.com$/, path: /^\/jobs\/(search|search-results|collections)/ },
];

// SPA sites need extra time after "complete" to render the list.
const SETTLE_MS = { 'robota.ua': 6000, 'jobico.io': 5000, 'linkedin.com': 6000 };

// Sites that are strict about automation: reload no more often than this, in minutes.
const SITE_MIN_INTERVAL = { 'linkedin.com': 30 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const isSupportedHost = (url) => LIST_PAGES.some((p) => p.host.test(parseUrl(url)?.hostname || ''));
const isListPage = (url) => {
  const u = parseUrl(url);
  return Boolean(u && LIST_PAGES.some((p) => p.host.test(u.hostname) && p.path.test(u.pathname)));
};

const siteKey = (url, table) => {
  const host = parseUrl(url)?.hostname || '';
  return Object.keys(table).find((k) => host === k || host.endsWith('.' + k));
};

const settleMs = (url) => SETTLE_MS[siteKey(url, SETTLE_MS)] ?? 2500;

function shortUrl(url) {
  const u = parseUrl(url);
  return u ? (u.hostname.replace(/^www\./, '') + u.pathname + u.search).slice(0, 90) : url;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(['intervalMin', 'server', 'safeMode', 'settleOverrideMs'])) };
}

// One-shot alarm re-armed after every tick, so each gap gets its own ±20% jitter.
async function scheduleAlarm(firstDelayMin) {
  const { intervalMin, safeMode } = await getSettings();
  const base = Math.max(1, intervalMin);
  const delay = firstDelayMin ?? (safeMode ? base * rand(0.8, 1.2) : base);
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { delayInMinutes: delay });
  await chrome.storage.local.set({ nextRunAt: new Date(Date.now() + delay * 60e3).toISOString() });
}

// ---------- log (shown live in the popup) ----------

let logQueue = Promise.resolve();
function log(level, text) {
  const entry = { t: new Date().toISOString(), level, text };
  logQueue = logQueue.then(async () => {
    const { log: entries = [] } = await chrome.storage.local.get('log');
    entries.push(entry);
    await chrome.storage.local.set({ log: entries.slice(-LOG_LIMIT) });
  });
  return logQueue;
}

// ---------- tab handling ----------

function reloadAndWait(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('вкладка не загрузилась за 45 с'));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (started && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId);
  });
}

async function runExtractor(tabId) {
  const inject = chrome.scripting.executeScript({ target: { tabId }, files: ['extract.js'] });
  const timeout = sleep(30000).then(() => {
    throw new Error('парсер не ответил за 30 с');
  });
  const [{ result } = {}] = await Promise.race([inject, timeout]);
  if (!result) throw new Error('парсер ничего не вернул');
  return result;
}

async function extract(tab) {
  await reloadAndWait(tab.id);
  const { settleOverrideMs } = await getSettings(); // e2e tests: static pages need no settle time
  await sleep(settleOverrideMs ?? settleMs(tab.url));
  return runExtractor(tab.id);
}

async function post(server, route, body) {
  const res = await fetch(`${server}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `сервер ответил ${res.status}`);
  return data;
}

// Most recent job: newest postedAt, otherwise the first one on the page.
function latestJob(jobs) {
  const dated = jobs.filter((j) => j.postedAt).sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  return dated[0] || jobs[0] || null;
}

// Tab the user is looking at right now — reloading it would be annoying (and look odd).
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

// ---------- run ----------

let running = false;

// mode: 'normal' — send today's new jobs; 'test' — send the latest job from every tab regardless of date
async function runCheck(mode = 'normal') {
  if (running) {
    log('warn', 'Проверка уже идёт — подожди окончания');
    return;
  }
  running = true;
  await chrome.storage.local.set({ running: true, log: [] });
  const { server, safeMode } = await getSettings();
  const isTest = mode === 'test';
  const summary = { tabs: 0, ok: 0, failed: 0, skipped: 0, sent: 0 };

  try {
    await log('info', isTest ? '🧪 ТЕСТ: последняя вакансия с каждой вкладки' : '▶ Проверка новых вакансий за сегодня');

    try {
      const res = await fetch(`${server}/health`);
      if (!res.ok) throw new Error(`статус ${res.status}`);
      await log('ok', `Сервер ${server} доступен`);
    } catch (e) {
      await log('error', `Сервер ${server} недоступен (${e.message}). Запущен ли npm start?`);
      summary.failed = -1;
      return;
    }

    const all = await chrome.tabs.query({});
    let tabs = all.filter((t) => t.url && isListPage(t.url));
    const skipped = all.filter((t) => t.url && isSupportedHost(t.url) && !isListPage(t.url));
    summary.tabs = tabs.length;
    await log('info', `Вкладок открыто: ${all.length}, со списками вакансий: ${tabs.length}`);
    for (const t of skipped) await log('warn', `Пропущена (не страница списка): ${shortUrl(t.url)}`);
    if (!tabs.length) {
      await log('error', 'Нет открытых вкладок со списками вакансий');
      return;
    }
    if (safeMode) tabs = shuffle(tabs);
    if (isTest) await post(server, '/test-start', { tabs: tabs.length }).catch(() => {});

    const { lastReloads = {} } = await chrome.storage.local.get('lastReloads');
    const activeId = safeMode && !isTest ? await activeTabId() : null;

    for (const [i, tab] of tabs.entries()) {
      const label = `[${i + 1}/${tabs.length}] ${shortUrl(tab.url)}`;

      // safe mode: don't reload the tab in front of the user, respect per-site minimum interval
      if (safeMode && !isTest) {
        if (tab.id === activeId) {
          await log('warn', `${label} — пропущена: ты сейчас на этой вкладке`);
          summary.skipped++;
          continue;
        }
        const minMin = SITE_MIN_INTERVAL[siteKey(tab.url, SITE_MIN_INTERVAL)];
        const last = lastReloads[tab.url];
        if (minMin && last && Date.now() - Date.parse(last) < minMin * 60e3) {
          const left = Math.ceil((minMin * 60e3 - (Date.now() - Date.parse(last))) / 60e3);
          await log('info', `${label} — пропущена: этот сайт проверяю не чаще раза в ${minMin} мин (ещё ${left} мин)`);
          summary.skipped++;
          continue;
        }
      }

      await log('info', `${label} — обновляю…`);
      try {
        const result = await extract(tab);
        lastReloads[tab.url] = new Date().toISOString();
        await chrome.storage.local.set({ lastReloads });
        const dated = result.jobs.filter((j) => j.postedAt).length;
        await log(result.jobs.length ? 'info' : 'error', `${label} — найдено вакансий: ${result.jobs.length} (с датой: ${dated})`);

        if (isTest) {
          const job = latestJob(result.jobs);
          await post(server, '/test-job', { page: result.page, site: result.site, found: result.jobs.length, job, debug: result.debug });
          if (job) {
            await log('ok', `${label} — в TG: «${job.title}» ${job.dateText ? `(${job.dateText})` : ''}\n${job.url}`);
            summary.sent++;
          }
        } else {
          const data = await post(server, '/jobs', result);
          await log('ok', `${label} — сегодня: ${data.today}, новых отправлено: ${data.sent}`);
          for (const j of data.sentJobs || []) await log('found', `🆕 ${j.title}
${j.url}`);
          summary.sent += data.sent;
        }
        if (result.jobs.length) summary.ok++;
        else summary.failed++;
      } catch (e) {
        summary.failed++;
        await log('error', `${label} — ошибка: ${e.message || e}`);
        if (isTest) {
          await post(server, '/test-job', { page: tab.url, site: shortUrl(tab.url), found: 0, job: null, error: String(e.message || e) }).catch(() => {});
        }
      }
      if (i < tabs.length - 1) await sleep(safeMode ? rand(3000, 9000) : 300);
    }
  } catch (e) {
    await log('error', `Сбой проверки: ${e.message || e}`);
  } finally {
    await log(
      summary.failed ? 'warn' : 'ok',
      `■ Готово. Вкладок: ${summary.tabs}, работают: ${summary.ok}, с проблемами: ${Math.max(0, summary.failed)}, ` +
        `пропущено: ${summary.skipped}, отправлено в TG: ${summary.sent}`,
    );
    if (isTest) await post(server, '/test-end', summary).catch(() => {});
    await chrome.storage.local.set({ running: false, lastRunAt: new Date().toISOString(), lastSummary: summary });
    running = false;
    await refreshBadge();
  }
  return summary;
}

// Saves the current DOM of every list tab to the server WITHOUT reloading — zero requests
// to the sites. Used to build offline fixtures for e2e tests.
async function snapshotTabs() {
  const { server } = await getSettings();
  const tabs = (await chrome.tabs.query({})).filter((t) => t.url && isListPage(t.url));
  await chrome.storage.local.set({ log: [] });
  await log('info', `📸 Снимок ${tabs.length} вкладок (без перезагрузки)`);
  let saved = 0;
  const pending = [];
  for (const tab of tabs) {
    const label = shortUrl(tab.url);
    // Discarded / frozen background tabs never run injected scripts until you open them.
    if (tab.discarded || tab.frozen) {
      await log('warn', `${label} — вкладка ${tab.discarded ? 'выгружена' : 'заморожена'} браузером, открой её и повтори`);
      pending.push(tab);
      continue;
    }
    try {
      const inject = chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => '<!doctype html>\n' + document.documentElement.outerHTML,
      });
      const timeout = sleep(15000).then(() => {
        throw new Error('вкладка не ответила за 15 с (вероятно, заморожена браузером) — открой её и повтори');
      });
      const [{ result: html } = {}] = await Promise.race([inject, timeout]);
      await post(server, '/snapshot', { page: tab.url, html });
      await log('ok', `${label} — сохранено (${Math.round(html.length / 1024)} КБ)`);
      saved++;
    } catch (e) {
      await log('error', `${label} — ${e.message || e}`);
      pending.push(tab);
    }
  }
  await log(saved === tabs.length ? 'ok' : 'warn', `■ Сохранено ${saved} из ${tabs.length} в data/snapshots`);
  if (pending.length) {
    await log('info', 'Чтобы снять остальные: пощёлкай по этим вкладкам (просто открой каждую) и нажми 📸 ещё раз');
  }
}

// ---------- on/off switch (lives on the server so Telegram can flip it too) ----------

async function fetchEnabled() {
  const { server } = await getSettings();
  try {
    const res = await fetch(`${server}/state`);
    const { enabled } = await res.json();
    await chrome.storage.local.set({ enabled });
    return enabled;
  } catch {
    return null; // server down — runCheck will log it
  }
}

// Badge: OFF when monitoring is switched off, otherwise the number of vacancies
// not yet marked in Telegram (👀 / ✅ / 👎).
async function refreshBadge() {
  const { server } = await getSettings();
  try {
    const [st, stats] = await Promise.all([
      fetch(`${server}/state`).then((r) => r.json()),
      fetch(`${server}/stats`).then((r) => r.json()),
    ]);
    await chrome.storage.local.set({ enabled: st.enabled, unread: stats.unread });
    if (st.enabled === false) {
      await chrome.action.setBadgeText({ text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#888' });
    } else {
      await chrome.action.setBadgeText({ text: stats.unread ? String(stats.unread) : '' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    }
  } catch {
    await chrome.action.setBadgeText({ text: '?' });
    await chrome.action.setBadgeBackgroundColor({ color: '#888' });
  }
}

// Scheduled tick: re-arm the alarm, then check unless monitoring is switched off.
async function onAlarmTick() {
  await scheduleAlarm();
  const enabled = await fetchEnabled();
  await refreshBadge();
  if (enabled === false) {
    await chrome.storage.local.set({ lastSkippedAt: new Date().toISOString() });
    return { skipped: 'disabled' };
  }
  return runCheck('normal');
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ running: false });
  scheduleAlarm(0.5);
  armBadgeAlarm();
  refreshBadge();
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ running: false });
  scheduleAlarm(1);
  armBadgeAlarm();
  refreshBadge();
});

// Local-only poll (localhost) so the badge follows buttons pressed in Telegram.
const BADGE_ALARM = 'job-observer-badge';
const armBadgeAlarm = () => chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) onAlarmTick();
  if (alarm.name === BADGE_ALARM) refreshBadge();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'run') runCheck(msg.mode);
  if (msg.type === 'snapshot') snapshotTabs();
  if (msg.type === 'reschedule') scheduleAlarm();
  if (msg.type === 'badge') refreshBadge();
  sendResponse({ ok: true });
});
