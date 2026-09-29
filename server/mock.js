// Offline fixtures (MOCK=1) so the UI can be developed without reaching publishers.
import { SOURCES } from './sources.js';

const HEADLINES = [
  ['ISRO readies next lunar mission for launch window early next year', 'The space agency said integration of the lander and rover modules is complete and final tests at Sriharikota will begin next month, officials said on Tuesday.'],
  ['Monsoon withdraws from northwest India, IMD says rainfall ended 8% above normal', 'The India Meteorological Department said the southwest monsoon has begun withdrawing from Rajasthan and Punjab, with the season closing above the long-period average.'],
  ['Sensex climbs 600 points as banking stocks rally on rate-cut hopes', 'Benchmark indices closed higher for a third straight session, led by private lenders, after comments from the central bank governor lifted sentiment.'],
  ['India beat Australia by 5 wickets to level the ODI series', 'A century from the opener and a late cameo from the wicketkeeper helped India chase down 289 with seven balls to spare in Chennai.'],
  ['Metro Phase 3 corridor to open for commuters next month', 'The 21-km stretch with 17 stations has cleared safety inspection, the metro rail corporation said, adding that trial runs will continue until the launch.'],
  ['New AI rules for social platforms come into force', 'Platforms must now label AI-generated images and videos and remove flagged deepfakes within 36 hours, under the amended IT rules notified by the ministry.'],
];

export function mockItems(sourceIds, category) {
  const sources = SOURCES.filter((s) => sourceIds.includes(s.id));
  const items = [];
  sources.forEach((s, si) => {
    HEADLINES.forEach(([title, summary], hi) => {
      if ((hi + si) % 2 && hi > 2) return;
      items.push({
        id: `m${si}${hi}`,
        kind: 'rss',
        via: 'rss',
        sourceId: s.id,
        sourceName: s.name,
        sourceColor: s.color,
        category,
        title,
        summary,
        link: `https://example.com/${s.id}/story-${hi}`,
        image: `/api/mock-image/${(hi + si) % 6}`,
        video: hi === 3 ? '/media/sample.mp4' : '',
        published: new Date(Date.now() - (hi * 47 + si * 13) * 60000).toISOString(),
      });
    });
  });
  items.sort((a, b) => b.published.localeCompare(a.published));
  return { items, xItems: [], status: sources.map((s) => ({ id: s.id, name: s.name, count: 6, feed: 'mock', errors: [] })) };
}

export function mockArticle(url) {
  const hi = Number(url.match(/story-(\d)/)?.[1] || 0);
  const [title, summary] = HEADLINES[hi] || HEADLINES[0];
  return {
    url,
    title,
    description: summary,
    image: `/api/mock-image/${hi}`,
    images: [`/api/mock-image/${hi}`, `/api/mock-image/${(hi + 1) % 6}`],
    videos: hi === 3 ? [{ url: '/media/sample.mp4', type: 'file' }] : [],
    text: `${summary} ${summary.replace(/said/g, 'noted')} The development is expected to be closely watched over the coming weeks, according to people familiar with the matter.`,
  };
}

const PALETTES = [
  ['#1b1f3b', '#8b5cf6', '#22d3ee'],
  ['#0f2027', '#2c5364', '#c6ff3d'],
  ['#2b1331', '#ff5a5f', '#ff9f1c'],
  ['#0b3d2e', '#1db954', '#e6ff6b'],
  ['#1a1a2e', '#e94560', '#0f3460'],
  ['#232526', '#414345', '#ffb400'],
];

export function mockImageSvg(n) {
  const [a, b, c] = PALETTES[n % PALETTES.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="1280" height="720" fill="url(#g)"/>
<circle cx="${300 + n * 120}" cy="260" r="180" fill="${c}" opacity=".55"/>
<rect x="760" y="380" width="360" height="220" rx="24" fill="#fff" opacity=".12"/>
<path d="M0 620 Q 320 520 640 600 T 1280 560 V720 H0Z" fill="#000" opacity=".35"/>
<text x="60" y="100" font-family="sans-serif" font-size="42" fill="#fff" opacity=".6">Sample photo ${n + 1}</text></svg>`;
}
