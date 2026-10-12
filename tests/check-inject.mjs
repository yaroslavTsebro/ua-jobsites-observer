// Quick offline check (no browser): does every fixture get a detectable injected vacancy?
import fs from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { loadFixtures, injectJob } from './lib.mjs';

const code = await fs.readFile(new URL('../extension/extract.js', import.meta.url), 'utf8');
async function extract(html, url) {
  const w = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() }).window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() {
      return [...this.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => e.textContent.trim()).filter(Boolean).join('\n') || this.textContent;
    },
  });
  return w.eval(code);
}
for (const [url, html] of await loadFixtures()) {
  try {
    const { html: out, title } = injectJob(html, url, { tag: 'chk' });
    const { jobs } = await extract(out, url);
    const j = jobs.find((x) => x.title.includes(title));
    const today = j?.postedAt && new Date(j.postedAt).toDateString() === new Date().toDateString();
    console.log(j && today ? '✅' : '❌', url.slice(0, 70), j ? `${j.url} | ${j.dateText}` : `not found (${jobs.length} jobs)`);
  } catch (e) {
    console.log('💥', url.slice(0, 70), e.message);
  }
}
