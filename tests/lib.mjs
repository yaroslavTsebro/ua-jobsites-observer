// Fixture helpers shared by the e2e test: loading saved pages and faking new vacancies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Selector of a vacancy link on each site — used to find a card to clone for "new job" scenarios.
export const LINKS = {
  'djinni.co': '[id^="job-item-"] a.job_item__header-link',
  'jobs.dou.ua': 'li.l-vacancy a.vt',
  'web3.career': 'tr.table_row[data-jobid] a[href]',
  'work.ua': 'h2 a[href*="/jobs/"]',
  'robota.ua': 'a[href*="/vacancy"]',
  'jobico.io': 'a[href*="/jobs/"]:not([href$="/jobs"]):not([href*="/jobs/new"])',
  'linkedin.com': '[role="button"][componentkey^="job-card-component-ref-"]',
};
// Card container, where the markup has an obvious one.
const CARDS = {
  'djinni.co': '[id^="job-item-"]',
  'jobs.dou.ua': 'li.l-vacancy',
  'web3.career': 'tr.table_row[data-jobid]',
  'work.ua': '.job-link',
  'linkedin.com': '[role="button"][componentkey^="job-card-component-ref-"]',
};
const TITLES = { 'linkedin.com': 'p' };
export const siteOf = (url) => Object.keys(LINKS).find((k) => new URL(url).hostname.endsWith(k));

export async function loadFixtures() {
  const files = [];
  for (const dir of [path.join(ROOT, 'tests', 'fixtures'), path.join(ROOT, 'data', 'snapshots')]) {
    for (const f of await fs.readdir(dir).catch(() => [])) if (f.endsWith('.html')) files.push(path.join(dir, f));
  }
  const pages = new Map(); // url -> html (snapshots override fixtures with the same url)
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const url = raw.match(/^<!-- (\S+) -->/)?.[1];
    if (url) pages.set(url, stripScripts(raw));
  }
  return pages;
}

// Static DOM only: no site JS runs, so the page can't phone home or re-render.
export const stripScripts = (html) =>
  html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*rel=["']?(preload|prefetch|modulepreload)[^>]*>/gi, '');

const UK_MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const pad = (n) => String(n).padStart(2, '0');

let seq = 0;
// Clones the first card on the page into a brand-new vacancy with today's date (or no date).
export function injectJob(html, url, { dated = true, tag = '' } = {}) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const sel = LINKS[siteOf(url)];
  const link = doc.querySelector(sel);
  if (!link) throw new Error(`no card to clone on ${url}`);

  // card: known container, otherwise the biggest ancestor that still holds only this one vacancy
  const href = link.getAttribute('href') || link.getAttribute('componentkey');
  let card = CARDS[siteOf(url)] ? link.closest(CARDS[siteOf(url)]) : null;
  if (!card) {
    card = link;
    for (let p = link.parentElement; p && p !== doc.body; p = p.parentElement) {
      const hrefs = new Set([...p.querySelectorAll(sel)].map((a) => a.getAttribute('href')));
      if (hrefs.size > 1) break;
      card = p;
    }
  }

  const n = ++seq;
  const newNum = String(9_000_000 + Math.floor(Math.random() * 900_000));
  // id lives in the path; query strings carry tracking ids (djinni ?sid=…) that must not be touched
  const idPart = href.includes('/') ? new URL(href, 'https://x').pathname : href;
  const nums = [...new Set(idPart.match(/\d{4,}/g) || [])]; // e.g. robota: /company123/vacancy456
  let clone = card.outerHTML;
  if (nums.length) nums.forEach((num, i) => (clone = clone.split(num).join(String(Number(newNum) + i))));
  else clone = clone.split(href).join(href.replace(/\/?$/, `-e2e${newNum}/`));

  const tmp = doc.createElement('template'); // <template> keeps <tr>/<li> intact
  tmp.innerHTML = clone;
  const el = tmp.content.firstElementChild;
  const title = `E2E ${tag} vacancy #${n}`;
  let titleEl = el.querySelector(TITLES[siteOf(url)] || 'h2, h3, .job-item__position') || el.querySelector(sel) || el;
  titleEl = titleEl.querySelector('a') || titleEl; // keep the link when the title is <h2><a>…</a></h2>
  titleEl.textContent = title;

  const now = new Date();
  for (const t of el.querySelectorAll('time[datetime]')) {
    if (dated) {
      t.setAttribute('datetime', now.toISOString());
      t.textContent = '1h';
    } else t.remove();
  }
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  for (const attr of ['title', 'data-bs-original-title']) {
    for (const t of el.querySelectorAll(`[${attr}]`)) {
      if (/\d{1,2}:\d{2}\s+\d{1,2}\.\d{1,2}\.\d{4}/.test(t.getAttribute(attr))) {
        if (dated) t.setAttribute(attr, stamp);
        else t.removeAttribute(attr);
      }
    }
  }
  const walker = doc.createTreeWalker(el, dom.window.NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    const s = node.textContent.trim();
    if (/^\d{1,2}\s+(січ|лют|бер|квіт|трав|черв|лип|серп|верес|жовт|листоп|груд|янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек)/i.test(s) && s.length < 25) node.textContent = dated ? `${now.getDate()} ${UK_MONTHS[now.getMonth()]}` : '';
    else if (/(тому|назад|\bago\b)$/.test(s) || /^\d+\s*[hdm]$/.test(s)) node.textContent = dated ? '1 годину тому' : '';
  }

  card.before(el);
  return { html: dom.serialize(), title };
}

