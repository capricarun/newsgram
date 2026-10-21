// Keyword search across news: Bing News RSS (direct links + thumbnails), the
// publishers' own feeds we already read, and Google News as a backup.
import crypto from 'node:crypto';
import { SOURCES, CATEGORIES } from './sources.js';
import { fetchFeed, fetchSource } from './news.js';
import { getArticle } from './article.js';
import { cached, stripHtml, mapLimit } from './util.js';
import { mockItems } from './mock.js';

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v == null ? '' : typeof v === 'object' ? v['#text'] ?? '' : String(v));
const RANGES = { '1d': { bing: '7', gn: '1d', ms: 864e5 }, '7d': { bing: '8', gn: '7d', ms: 7 * 864e5 }, '30d': { bing: '9', gn: '30d', ms: 30 * 864e5 } };
const OTHER_COLORS = ['#8B5CF6', '#22D3EE', '#F59E0B', '#10B981', '#EC4899', '#3B82F6', '#EF4444', '#A3E635'];

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const knownSource = (host) => SOURCES.find((s) => host === s.domain || host.endsWith(`.${s.domain}`));
const colorFor = (name) => OTHER_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % OTHER_COLORS.length];
const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 70);

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Drop a trailing " - Publisher" that search engines append to headlines. */
function stripTail(t, names) {
  for (const n of names.filter(Boolean)) t = t.replace(new RegExp(`\\s[-|–]\\s*${escRe(n)}\\s*$`, 'i'), '');
  return t.trim();
}

function makeItem({ title, summary, link, image, published, sourceName, via }) {
  const host = hostOf(link);
  const src = knownSource(host);
  const name = src?.name || sourceName || host || 'News';
  const date = new Date(published || Date.now());
  return {
    id: crypto.createHash('md5').update(link || title).digest('hex').slice(0, 12),
    kind: 'rss',
    via,
    search: true,
    sourceId: src?.id || `web:${host}`,
    sourceName: name,
    sourceColor: src?.color || colorFor(name),
    category: 'top',
    title: stripTail(stripHtml(title), [sourceName, src?.name]),
    summary: stripHtml(summary || '').slice(0, 600),
    link,
    image: image || '',
    video: '',
    published: isNaN(date) ? new Date().toISOString() : date.toISOString(),
  };
}

/** Bing wraps links as bing.com/news/apiclick.aspx?…&url=<real>. */
function unwrapBing(link) {
  try {
    const u = new URL(link);
    return u.searchParams.get('url') || link;
  } catch {
    return link;
  }
}

function siteFilter(sources) {
  return sources.length ? `(${sources.map((s) => `site:${s.domain}`).join(' OR ')})` : '';
}

async function bingSearch(q, sources, range) {
  const query = [q, siteFilter(sources)].filter(Boolean).join(' ');
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-IN&qft=${encodeURIComponent(`interval="${RANGES[range].bing}"`)}&count=50`;
  const list = await fetchFeed(url);
  return list.map((it) => {
    const img = text(it['News:Image']) || it['News:Image']?.['@_url'] || '';
    return makeItem({
      title: text(it.title),
      summary: text(it.description),
      link: unwrapBing(text(it.link)),
      // Bing thumbnails can be requested larger.
      image: img ? (/bing\.(com|net)\/th/.test(img) ? `${img.replace(/^http:/, 'https:').replace(/&(w|h|c)=\d+/g, '')}&w=1200` : img.replace(/^http:/, 'https:')) : '',
      published: text(it.pubDate),
      sourceName: text(it['News:Source']),
      via: 'bing',
    });
  });
}

async function googleSearch(q, sources, range) {
  const ta = /[஀-௿]/.test(q);
  const query = `${q} ${siteFilter(sources)} when:${RANGES[range].gn}`.trim();
  const loc = ta ? 'hl=ta&gl=IN&ceid=IN:ta' : 'hl=en-IN&gl=IN&ceid=IN:en';
  const list = await fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`);
  return list.map((it) =>
    makeItem({
      title: text(it.title),
      summary: '',
      link: text(it.link),
      published: text(it.pubDate),
      sourceName: text(it.source),
      via: 'gnews',
    }),
  );
}

/** Stories already in the publishers' feeds that mention every keyword. */
async function feedSearch(q, sources, range, category) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !/^(and|or|the|in|of|to)$/.test(w));
  if (!words.length) return [];
  const since = Date.now() - RANGES[range].ms;
  const cats = [...new Set(['top', category].filter((c) => CATEGORIES.some((x) => x.id === c)))];
  const lists = await mapLimit(
    sources.flatMap((s) => cats.map((c) => [s, c])),
    6,
    ([s, c]) => fetchSource(s, c).then((r) => r.items).catch(() => []),
  );
  return lists
    .flat()
    .filter(Boolean)
    .filter((it) => Date.parse(it.published) >= since)
    .filter((it) => {
      const hay = `${it.title} ${it.summary}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((it) => ({ ...it, search: true, category: 'top' }));
}

export async function searchNews({ q, sourceIds = [], scope = 'selected', range = '7d', category = 'top' }) {
  q = String(q || '').trim().slice(0, 120);
  if (!q) throw Object.assign(new Error('Type something to search for'), { status: 400 });
  if (!RANGES[range]) range = '7d';
  const sources = scope === 'all' ? [] : SOURCES.filter((s) => sourceIds.includes(s.id));

  if (process.env.MOCK === '1') {
    const all = mockItems(sources.length ? sources.map((s) => s.id) : SOURCES.map((s) => s.id), 'top').items;
    const words = q.toLowerCase().split(/\s+/);
    const hits = all.filter((it) => words.some((w) => `${it.title} ${it.summary}`.toLowerCase().includes(w)));
    return { q, items: (hits.length ? hits : all.slice(0, 6)).map((i) => ({ ...i, search: true })), engines: [{ name: 'mock', count: hits.length }] };
  }

  return cached(`search:${q}:${category}:${scope}:${sources.map((s) => s.id).join(',')}:${range}`, 5 * 60 * 1000, async () => {
    const engines = [];
    const run = async (name, fn) => {
      try {
        const items = await fn();
        engines.push({ name, count: items.length });
        return items;
      } catch (e) {
        engines.push(/^No items/.test(e.message) ? { name, count: 0 } : { name, count: 0, error: e.message });
        return [];
      }
    };
    const [feeds, bing] = await Promise.all([
      sources.length && sources.length <= 6 ? run('Publisher feeds', () => feedSearch(q, sources, range, category)) : Promise.resolve([]),
      run('Bing News', () => bingSearch(q, sources, range)),
    ]);
    let google = [];
    if (feeds.length + bing.length < 8) google = await run('Google News', () => googleSearch(q, sources, range));

    // Merge, newest first, dropping duplicates by link or near-identical headline.
    const seen = new Set();
    const items = [];
    for (const it of [...feeds, ...bing, ...google].sort((a, b) => b.published.localeCompare(a.published))) {
      const k1 = it.link;
      const k2 = normTitle(it.title);
      if (!it.title || seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      seen.add(k2);
      items.push(it);
    }
    const top = items.slice(0, 40);

    // Fill missing images from the article's og:image (not possible for Google News redirect links).
    const missing = top.filter((i) => !i.image && !/news\.google\.com/.test(i.link)).slice(0, 16);
    await mapLimit(missing, 8, async (it) => {
      const a = await getArticle(it.link, { lite: true }).catch(() => null);
      if (a?.image) it.image = a.image;
      if (a?.videos?.length && !it.video) it.video = a.videos[0].url;
    });
    return { q, items: top, engines };
  });
}
