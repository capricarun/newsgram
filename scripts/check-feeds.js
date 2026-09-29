// Checks every preset feed and reports item counts and image coverage.
// Run: npm run check-feeds
import { SOURCES, CATEGORIES } from '../server/sources.js';
import { fetchSource } from '../server/news.js';

const rows = [];
for (const s of SOURCES) {
  for (const c of CATEGORIES) {
    const r = await fetchSource(s, c.id);
    const withImg = r.items.filter((i) => i.image).length;
    const via = !r.feed ? 'FAILED' : /news\.google/.test(r.feed) ? 'google-news' : 'rss';
    rows.push({ source: s.name, category: c.id, items: r.items.length, images: withImg, via, error: r.errors[0]?.slice(0, 70) || '' });
  }
}
console.table(rows);
const failed = rows.filter((r) => r.via !== 'rss');
console.log(failed.length ? `\n${failed.length} feed(s) need attention — update server/sources.js.` : '\nAll publisher feeds OK.');
