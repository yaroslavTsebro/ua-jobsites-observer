// Injected into a job list tab. The value of the last expression (a promise) is
// returned to background.js: { page, site, jobs: [{ id, url, title, company, dateText, postedAt }] }
(async () => {
  const now = new Date();
  const host = location.hostname;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- date parsing (uk / ru / en) ----------

  const MONTHS = {
    січ: 0, лют: 1, бер: 2, квіт: 3, трав: 4, черв: 5, лип: 6, серп: 7, верес: 8, жовт: 9, листоп: 10, груд: 11,
    янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const L = 'a-zа-яіїєґё';
  const ago = (ms) => new Date(now.getTime() - ms);
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

  function monthIndex(word) {
    const w = word.toLowerCase();
    const key = Object.keys(MONTHS).find((k) => w.startsWith(k));
    return key === undefined ? -1 : MONTHS[key];
  }

  // Absolute formats, safe to apply to any attribute or text.
  function parseAbsolute(s) {
    let m;
    // djinni tooltip: "11:34 05.10.2026"
    if ((m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/)))
      return new Date(+m[5], m[4] - 1, +m[3], +m[1], +m[2]);
    // ISO with time: "2026-10-10 22:10:56+07:00" / "2026-10-10T22:10:56Z"
    if ((m = s.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/))) {
      const d = new Date(m[0].replace(' ', 'T'));
      if (!isNaN(d)) return d;
    }
    // date only "2026-10-11" -> local date
    if ((m = s.match(/(\d{4})-(\d{2})-(\d{2})/))) return new Date(+m[1], m[2] - 1, +m[3], 12);
    // "11.10.2026"
    if ((m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/))) return new Date(+m[3], m[2] - 1, +m[1], 12);
    return null;
  }

  // Human text like "сьогодні", "2 години тому", "12h", "11 жовтня".
  function parseHuman(raw) {
    const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s || s.length > 60) return null;

    if (/сьогодні|сегодня|\btoday\b|just now|щойно|только что|moments? ago/.test(s)) return now;
    if (/вчора|вчера|yesterday/.test(s)) return ago(DAY);

    const isRelative = /тому|назад|\bago\b/.test(s) || /^\d+\s*[mhdw]$/.test(s);
    if (isRelative) {
      const unit = (re) => s.match(new RegExp(`(\\d+)\\s*(?:${re})(?![${L}])`));
      let m;
      if ((m = unit(`хвилин[${L}]*|хв|минут[${L}]*|мин|minutes?|mins?|m`))) return ago(m[1] * MIN);
      if ((m = unit(`годин[${L}]*|год|час[${L}]*|hours?|hrs?|h`))) return ago(m[1] * HOUR);
      if ((m = unit(`дн[${L}]*|день|дня|days?|d`))) return ago(m[1] * DAY);
      if (/годину|час назад|an hour|one hour/.test(s)) return ago(HOUR);
      if (/хвилину|минуту|a minute/.test(s)) return ago(MIN);
      if (/(^|\s)(день|a day|one day)/.test(s)) return ago(DAY);
      // weeks / months / years -> definitely old
      return ago(30 * DAY);
    }

    // "11 жовтня", "11 октября 2025", "11 oct"
    let m = s.match(new RegExp(`^(\\d{1,2})\\s+([${L}]{3,})\\.?(?:\\s+(\\d{4}))?`));
    if (m && monthIndex(m[2]) >= 0) {
      const d = new Date(m[3] ? +m[3] : now.getFullYear(), monthIndex(m[2]), +m[1], 12);
      if (!m[3] && d - now > 2 * DAY) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
    // "oct 11"
    m = s.match(new RegExp(`^([${L}]{3,})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?$`));
    if (m && monthIndex(m[1]) >= 0) {
      return new Date(m[3] ? +m[3] : now.getFullYear(), monthIndex(m[1]), +m[2], 12);
    }
    return null;
  }

  function findDate(card, dateSel, title) {
    const pick = (text, date) => (date ? { dateText: text.trim(), postedAt: date.toISOString() } : null);

    if (dateSel) {
      const el = card.querySelector(dateSel);
      if (el) {
        const attr = el.getAttribute('datetime') || el.getAttribute('title') || el.getAttribute('data-bs-original-title') || '';
        const r = pick(el.innerText || attr, parseAbsolute(attr) || parseHuman(el.innerText || ''));
        if (r) return r;
      }
    }
    for (const el of card.querySelectorAll('time[datetime]')) {
      const r = pick(el.innerText || el.getAttribute('datetime'), parseAbsolute(el.getAttribute('datetime')));
      if (r) return r;
    }
    for (const el of card.querySelectorAll('[title]')) {
      const r = pick(el.innerText || el.title, parseAbsolute(el.title));
      if (r) return r;
    }
    for (const line of (card.innerText || '').split('\n')) {
      if (title && line.includes(title)) continue;
      for (const part of line.split(/\s+[·•|]\s+/)) {
        const r = pick(part, parseHuman(part));
        if (r) return r;
      }
    }
    return { dateText: '', postedAt: null };
  }

  // ---------- per-site config ----------
  // item: card selector (optional — otherwise the card is found by climbing up from the link)
  // link: vacancy link selector, title/company/date: selectors inside the card

  const SITES = [
    {
      site: 'djinni', match: /djinni\.co$/,
      item: '[id^="job-item-"]', link: 'a.job_item__header-link, a[href^="/jobs/"]',
      title: '.job-item__position, h2', company: 'span.small.text-gray-800',
      // Bootstrap moves title -> data-bs-original-title once the tooltip is initialised
      date: '[data-bs-toggle="tooltip"][title*=":"], [data-bs-original-title*=":"]',
    },
    {
      site: 'dou', match: /jobs\.dou\.ua$/,
      item: 'li.l-vacancy', link: 'a.vt', title: 'a.vt', company: 'a.company', date: '.date',
    },
    {
      site: 'work.ua', match: /work\.ua$/,
      item: '.job-link, .card:has(h2 a[href*="/jobs/"])', link: 'h2 a[href*="/jobs/"]',
      title: 'h2', company: '.text-indent:has(.glyphicon-company) .strong-600', date: 'time[datetime]',
    },
    {
      site: 'robota.ua', match: /robota\.ua$/,
      link: 'a[href*="/vacancy"]', title: 'h2, h3, [class*="title"]',
    },
    {
      site: 'jobico', match: /jobico\.io$/,
      link: 'a[href*="/jobs/"]', title: 'h2, h3, [class*="title"]',
      skip: /\/jobs\/?$|\/jobs\/new|\/employer\//,
    },
    {
      site: 'web3.career', match: /web3\.career$/,
      item: 'tr.table_row[data-jobid]', link: 'a[href]', title: 'h2', company: 'h3', date: 'time[datetime]',
    },
    {
      // New UI (/jobs/search-results/): cards are clickable divs without links, the job id
      // sits in componentkey="job-card-component-ref-<id>". Old UI: li[data-occludable-job-id].
      site: 'linkedin', match: /linkedin\.com$/,
      item: '[role="button"][componentkey^="job-card-component-ref-"], li[data-occludable-job-id]',
      link: 'a[href*="/jobs/view/"]',
      cardId: (c) =>
        c.getAttribute('componentkey')?.match(/(\d+)$/)?.[1] ||
        c.getAttribute('data-occludable-job-id') ||
        c.querySelector('a[href*="/jobs/view/"]')?.href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1],
      cardUrl: (id) => `https://www.linkedin.com/jobs/view/${id}/`,
      title: '.job-card-list__title, .artdeco-entity-lockup__title, p',
      company: (c) => c.querySelector('.artdeco-entity-lockup__subtitle') || c.querySelectorAll('p')[1],
    },
  ];

  const cfg = SITES.find((s) => s.match.test(host));
  if (!cfg) return { page: location.href, site: host, jobs: [] };

  function jobId(href) {
    const u = new URL(href, location.href);
    if (cfg.site === 'linkedin') {
      const id = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1] || u.searchParams.get('currentJobId');
      return id ? `https://www.linkedin.com/jobs/view/${id}/` : null;
    }
    return u.origin + u.pathname.replace(/\/$/, '') + '/';
  }

  const text = (el) => (el?.innerText || el?.textContent || '').split('\n').map((s) => s.trim()).find(Boolean) || '';

  // ---------- load lazy lists (LinkedIn / SPA) ----------

  async function scrollLists() {
    const links = [...document.querySelectorAll(cfg.item || cfg.link)];
    const scrollers = new Set();
    for (const a of links.slice(0, 3)) {
      for (let el = a.parentElement; el && el !== document.body; el = el.parentElement) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 50) {
          scrollers.add(el);
          break;
        }
      }
    }
    const targets = [...scrollers, document.scrollingElement || document.documentElement];
    for (let i = 1; i <= 6; i++) {
      for (const el of targets) el.scrollTop = (el.scrollHeight * i) / 6;
      await sleep(400);
    }
    for (const el of targets) el.scrollTop = 0;
  }

  await scrollLists();

  // ---------- collect ----------

  function cardFor(link) {
    if (cfg.item) {
      const c = link.closest(cfg.item);
      if (c) return c;
    }
    // climb while the ancestor still contains links to only this vacancy
    const id = jobId(link.href);
    let card = link;
    for (let p = link.parentElement; p && p !== document.body; p = p.parentElement) {
      const ids = new Set([...p.querySelectorAll(cfg.link)].map((a) => jobId(a.href)));
      if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
      card = p;
    }
    return card;
  }

  const links = cfg.item
    ? [...document.querySelectorAll(cfg.item)].map((c) => c.querySelector(cfg.link) || (c.matches('a') ? c : null))
    : [...document.querySelectorAll(cfg.link)];

  const pickEl = (card, sel) => (typeof sel === 'function' ? sel(card) : sel && card.querySelector(sel));

  const jobs = new Map();

  // Sites where the card itself carries the id (no <a> to the vacancy).
  if (cfg.cardId) {
    for (const card of document.querySelectorAll(cfg.item)) {
      const num = cfg.cardId(card);
      const url = num && cfg.cardUrl(num);
      if (!url || jobs.has(url)) continue;
      const title = text(pickEl(card, cfg.title));
      if (!title) continue;
      jobs.set(url, { id: url, url, title, company: text(pickEl(card, cfg.company)), ...findDate(card, cfg.date, title) });
    }
  }

  for (const link of cfg.cardId ? [] : links) {
    if (!link?.href || (cfg.skip && cfg.skip.test(new URL(link.href, location.href).pathname))) continue;
    const id = jobId(link.href);
    if (!id || jobs.has(id)) continue;
    const card = cardFor(link);
    const title = text(cfg.title && card.querySelector(cfg.title)) || text(link);
    if (!title) continue;
    jobs.set(id, {
      id,
      url: id,
      title,
      company: text(pickEl(card, cfg.company)),
      ...findDate(card, cfg.date, title),
    });
  }

  // Diagnostics for tuning selectors: what the page looked like when nothing was parsed.
  const debug = {
    title: document.title,
    linkCandidates: document.querySelectorAll(cfg.link).length,
    itemCandidates: cfg.item ? document.querySelectorAll(cfg.item).length : null,
  };
  const firstCard = cfg.cardId ? document.querySelector(cfg.item) : links.find(Boolean) && cardFor(links.find(Boolean));
  if (firstCard) debug.firstCard = firstCard.outerHTML.slice(0, 6000);
  if (!jobs.size) {
    // Climb from a "posted N days ago" text node to see how cards are built.
    const re = /^(опубліковано|опубликовано|posted|reposted|\d+\s+(годин|дн|тиж|hour|day|week))/i;
    const leaf = [...document.querySelectorAll('main *, body *')].find(
      (e) => !e.children.length && re.test((e.textContent || '').trim()),
    );
    if (leaf) {
      const chain = [];
      let el = leaf;
      for (let i = 0; i < 12 && el && el !== document.body; i++, el = el.parentElement) {
        chain.push(el.tagName.toLowerCase() + [...el.attributes].map((a) => ` ${a.name}="${a.value.slice(0, 120)}"`).join(''));
      }
      debug.probeChain = chain;
      let up = leaf;
      for (let i = 0; i < 9 && up.parentElement && up.parentElement !== document.body; i++) up = up.parentElement;
      debug.probeHtml = up.outerHTML.slice(0, 25000);
    }
    debug.bodyText = (document.body?.innerText || '').slice(0, 3000);
    debug.sampleLinks = [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && !h.startsWith('#'))
      .slice(0, 150);
    const first = document.querySelector(cfg.link);
    debug.sampleCard = first ? cardFor(first).outerHTML.slice(0, 5000) : null;
  }

  return { page: location.href, site: cfg.site, jobs: [...jobs.values()], debug };
})();
