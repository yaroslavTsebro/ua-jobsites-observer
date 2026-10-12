const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 15, server: 'http://localhost:3777' };

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function renderLog(entries = []) {
  const box = $('log');
  if (!entries.length) {
    box.innerHTML = '<div class="muted">Лог пуст — запусти проверку</div>';
    return;
  }
  box.innerHTML = entries
    .map((e) => `<div class="e ${e.level}"><time>${new Date(e.t).toLocaleTimeString()}</time>${esc(e.text)}</div>`)
    .join('');
  box.scrollTop = box.scrollHeight; // always follow the latest entry
}

function renderState({ running, lastRunAt }) {
  $('run').disabled = $('test').disabled = $('snapshot').disabled = Boolean(running);
  $('state').textContent = running
    ? '⏳ идёт проверка…'
    : lastRunAt
      ? `последняя: ${new Date(lastRunAt).toLocaleTimeString()}`
      : '';
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  $('interval').value = s.intervalMin;
  $('server').value = s.server;
  renderLog(s.log);
  renderState(s);
  $('log').scrollTop = $('log').scrollHeight;
}

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.log) renderLog(changes.log.newValue);
  if (changes.running || changes.lastRunAt) renderState(await chrome.storage.local.get(['running', 'lastRunAt']));
});

$('save').onclick = async () => {
  await chrome.storage.local.set({
    intervalMin: Math.max(1, Number($('interval').value) || DEFAULTS.intervalMin),
    server: $('server').value.trim().replace(/\/$/, '') || DEFAULTS.server,
  });
  await chrome.runtime.sendMessage({ type: 'reschedule' });
  $('save').textContent = 'Сохранено ✓';
  setTimeout(() => ($('save').textContent = 'Сохранить'), 1200);
};

function renderToggle(enabled) {
  const btn = $('toggle');
  btn.dataset.enabled = String(enabled);
  btn.disabled = enabled === null;
  btn.className = `toggle ${enabled ? 'on' : 'off'}`;
  btn.textContent =
    enabled === null
      ? 'Сервер недоступен — состояние неизвестно'
      : enabled
        ? '🟢 Мониторинг включён — нажми, чтобы выключить'
        : '⏸ Мониторинг выключен — нажми, чтобы включить';
}

async function serverUrl() {
  return (await chrome.storage.local.get('server')).server || DEFAULTS.server;
}

function renderUnread(stats) {
  const box = $('unread');
  if (!stats) {
    $('unreadCount').textContent = '—';
    box.className = 'zero';
    $('unreadList').innerHTML = '';
    return;
  }
  $('unreadCount').textContent = stats.unread;
  box.className = stats.unread ? '' : 'zero';
  $('unreadList').innerHTML = stats.unreadJobs
    .map(
      (j) => `<li><a data-url="${esc(j.url)}">${esc(j.title)}</a>
        <div class="meta">${esc([j.site, j.company, new Date(j.sentAt).toLocaleString()].filter(Boolean).join(' · '))}</div></li>`,
    )
    .join('');
}

$('unreadList').onclick = (e) => {
  const url = e.target.closest('a')?.dataset.url;
  if (url) chrome.tabs.create({ url });
};

async function refreshToggle() {
  const server = await serverUrl();
  try {
    const [{ enabled }, stats] = await Promise.all([
      fetch(`${server}/state`).then((r) => r.json()),
      fetch(`${server}/stats`).then((r) => r.json()),
    ]);
    renderToggle(enabled);
    renderUnread(stats);
    chrome.runtime.sendMessage({ type: 'badge' });
  } catch {
    renderToggle(null);
    renderUnread(null);
  }
}

$('toggle').onclick = async () => {
  const next = $('toggle').dataset.enabled !== 'true';
  $('toggle').disabled = true;
  try {
    const res = await fetch(`${await serverUrl()}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    const { enabled } = await res.json();
    renderToggle(enabled);
    chrome.runtime.sendMessage({ type: 'badge' });
  } catch {
    renderToggle(null);
  }
};

$('run').onclick = () => chrome.runtime.sendMessage({ type: 'run', mode: 'normal' });
$('test').onclick = () => chrome.runtime.sendMessage({ type: 'run', mode: 'test' });
$('snapshot').onclick = () => chrome.runtime.sendMessage({ type: 'snapshot' });

load();
refreshToggle();
setInterval(refreshToggle, 5000); // picks up switches made from Telegram while the popup is open
