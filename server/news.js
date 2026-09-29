import { XMLParser } from 'fast-xml-parser';
import crypto from 'node:crypto';
import { SOURCES, googleNewsUrl, supports } from './sources.js';
import { scrapeListing } from './scrape.js';
import { cached, fetchText, stripHtml, mapLimit } from './util.js';
import { getArticle } from './article.js';
import { fetchXPosts } from './x.js';
import { mockItems } from './mock.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: false,
  textNodeName: '#text',
  trimValues: true,
});

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v == null ? '' : typeof v === 'object' ? v['#text'] ?? '' : String(v));

function pickImage(item) {
  const candidates = [];
  const push = (url, w = 0, type = '') => {
    if (url && /^https?:/.test(url) && !/video|audio/.test(type)) candidates.push({ url, w: Number(w) || 0 });
  };
  for (const m of arr(item['media:content'])) push(m['@_url'], m['@_width'], m['@_type'] || m['@_medium']);
  for (const g of arr(item['media:group'])) for (const m of arr(g['media:content'])) push(m['@_url'], m['@_width'], m['@_type']);
  for (const m of arr(item['media:thumbnail'])) push(m['@_url'], m['@_width']);
  for (const e of arr(item.enclosure)) if (!e['@_type'] || /image/.test(e['@_type'])) push(e['@_url'], 0);
  if (item.image) push(text(item.image.url || item.image));
  const html = text(item.description) + ' ' + text(item['content:encoded']);
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) push(m[1]);
  candidates.sort((a, b) => b.w - a.w);
  return candidates[0]?.url || '';
}

function pickVideo(item) {
  for (const m of arr(item['media:content'])) {
    const t = m['@_type'] || m['@_medium'] || '';
    if (/video/.test(t) && m['@_url']) return m['@_url'];
  }
  for (const e of arr(item.enclosure)) if (/video/.test(e['@_type'] || '')) return e['@_url'];
  return '';
}

function cleanTitle(t, source) {
  let s = stripHtml(t);
  // Google News appends " - Publisher"
  s = s.replace(new RegExp(`\\s[-|–]\\s*${source.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '');
  return s;
}

function normalise(item, source, category, via) {
  const link = text(item.link) || item.link?.['@_href'] || text(item.guid);
  const title = cleanTitle(text(item.title), source);
  const summary = stripHtml(text(item.description) || text(item['content:encoded'])).slice(0, 600);
  const published = new Date(text(item.pubDate) || text(item['dc:date']) || text(item.updated) || Date.now());
  return {
    id: crypto.createHash('md5').update(link || title).digest('hex').slice(0, 12),
    kind: 'rss',
    via,
    sourceId: source.id,
    sourceName: source.name,
    sourceColor: source.color,
    category,
    title,
    summary: summary === title ? '' : summary,
    link: link.replace(/#publisher=.*$/, ''),
    image: via === 'gnews' ? '' : pickImage(item),
    video: pickVideo(item),
    published: isNaN(published) ? new Date().toISOString() : published.toISOString(),
  };
}

async function fetchFeed(url) {
  const xml = await fetchText(url, 10000);
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item;
  const list = arr(items);
  if (!list.length) throw new Error(`No items in ${url}`);
  return list;
}

const MIN_ITEMS = 6;

async function scrapedItems(source, category, url) {
  const links = await scrapeListing(url, 16);
  const items = await mapLimit(links, 6, async (l, idx) => {
    const a = await getArticle(l.link, { lite: true }).catch(() => null);
    const title = cleanTitle((l.title.length >= 15 ? l.title : a?.title) || '', source);
    if (!title) return null;
    return {
      id: crypto.createHash('md5').update(l.link).digest('hex').slice(0, 12),
      kind: 'rss',
      via: 'scrape',
      sourceId: source.id,
      sourceName: source.name,
      sourceColor: source.color,
      category,
      title,
      summary: stripHtml(a?.description || '').slice(0, 600),
      link: l.link,
      image: a?.image || l.image || '',
      video: a?.videos?.find((v) => v.type === 'file')?.url || '',
      // Section pages list newest first; keep that order when no date is published.
      published: a?.published || new Date(Date.now() - idx * 60000).toISOString(),
    };
  });
  return items.filter(Boolean);
}

export async function fetchSource(source, category) {
  return cached(`src:${source.id}:${category}`, 5 * 60 * 1000, async () => {
    const errors = [];
    if (!supports(source, category)) return { items: [], feed: null, via: 'unsupported', errors: [`${source.name} has no section for this category`] };

    let items = [];
    let feed = null;
    const seen = new Set();
    const add = (list) => {
      for (const it of list) if (!seen.has(it.link)) (seen.add(it.link), items.push(it));
    };

    for (const url of source.feeds?.[category] || []) {
      try {
        add((await fetchFeed(url)).slice(0, 20).map((i) => normalise(i, source, category, 'rss')));
        feed = feed || url;
        if (items.length >= MIN_ITEMS) break;
      } catch (e) {
        errors.push(e.message);
      }
    }

    // Thin or missing feed: read the section page itself.
    let via = items.length ? 'rss' : '';
    const page = source.pages?.[category];
    if (items.length < MIN_ITEMS && page) {
      try {
        const before = items.length;
        add(await scrapedItems(source, category, page));
        if (items.length > before) {
          via = via ? 'rss+page' : 'page';
          feed = feed || page;
        }
      } catch (e) {
        errors.push(`page: ${e.message}`);
      }
    }
    if (items.length) return { items: items.slice(0, 20), feed, via, errors };

    // Last resort: Google News search scoped to the publisher's domain.
    const g = googleNewsUrl(source, category);
    try {
      const list = await fetchFeed(g);
      return { items: list.slice(0, 15).map((i) => normalise(i, source, category, 'gnews')), feed: g, via: 'gnews', errors };
    } catch (e) {
      errors.push(e.message);
    }
    return { items: [], feed: null, via: 'failed', errors };
  });
}

/** Aggregates the chosen sources, interleaves them by recency and fills missing images from og:image. */
export async function getNews({ sourceIds, category, includeX }) {
  if (process.env.MOCK === '1') return mockItems(sourceIds, category);
  const sources = SOURCES.filter((s) => sourceIds.includes(s.id));
  const results = await Promise.all(
    sources.map(async (s) => {
      const r = await fetchSource(s, category);
      let x = [];
      if (includeX) {
        try {
          x = await fetchXPosts(s);
        } catch (e) {
          r.errors = [...r.errors, `X: ${e.message}`];
        }
      }
      return { source: s, ...r, x };
    }),
  );

  // Round-robin interleave so one prolific source doesn't dominate the grid.
  const queues = results.map((r) => [...r.items].sort((a, b) => b.published.localeCompare(a.published)));
  const merged = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) merged.push(q.shift());
  const items = merged.slice(0, 48);

  const missing = items.filter((i) => !i.image && i.via === 'rss').slice(0, 20);
  await mapLimit(missing, 8, async (it) => {
    const a = await getArticle(it.link, { lite: true });
    if (a?.image) it.image = a.image;
    if (a?.videos?.length && !it.video) it.video = a.videos[0].url;
  });

  const xItems = results.flatMap((r) => r.x).sort((a, b) => b.published.localeCompare(a.published));

  return {
    items,
    xItems,
    status: results.map((r) => ({ id: r.source.id, name: r.source.name, count: r.items.length, feed: r.feed, via: r.via, errors: r.errors })),
  };
}
