// Checks every preset feed and reports item counts and image coverage.
// Run: npm run check-feeds
import { SOURCES, CATEGORIES, supports } from '../server/sources.js';
import { fetchSource } from '../server/news.js';

// Optional filter: npm run check-feeds -- tamil   (or a source id like polimer)
const only = process.argv[2];
const rows = [];
for (const s of SOURCES.filter((x) => !only || x.group === only || x.id === only)) {
  for (const c of CATEGORIES) {
    if (!supports(s, c.id)) continue;
    const r = await fetchSource(s, c.id);
    const withImg = r.items.filter((i) => i.image).length;
    const via = r.via === 'failed' ? 'FAILED' : r.via === 'gnews' ? 'google-news' : r.via;
    rows.push({ source: s.name, category: c.id, items: r.items.length, images: withImg, via, error: r.errors[0]?.slice(0, 70) || '' });
  }
}
console.table(rows);
const failed = rows.filter((r) => r.via === 'FAILED' || r.via === 'google-news');
console.log(failed.length ? `\n${failed.length} feed(s) need attention — update server/sources.js.` : '\nAll publisher feeds OK.');
