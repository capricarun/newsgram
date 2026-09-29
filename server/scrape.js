// Fallback for publishers without a usable RSS feed: reads a section page and
// picks out links that look like articles (the og:image / og:title of each is
// filled in later by getArticle).
import * as cheerio from 'cheerio';
import { fetchText, stripHtml } from './util.js';

const SKIP = /\/(tag|tags|topic|topics|author|authors|category|section|search|login|signup|subscribe|about|contact|privacy|terms|disclaimer|advertise|careers|rss|feed|live-tv|livetv|video\/watch|web-?stor(y|ies)|photos?|gallery|galleries|podcasts?|epaper|horoscope|jobs)(\/|$)/i;
const ASSET = /\.(jpe?g|png|gif|webp|svg|pdf|mp4|mp3|css|js)$/i;

export function looksLikeArticle(pathname) {
  if (SKIP.test(pathname) || ASSET.test(pathname)) return false;
  const segs = pathname.split('/').filter(Boolean);
  if (!segs.length) return false;
  const last = decodeURIComponent(segs[segs.length - 1]).replace(/\.html?$/, '');
  if (/\d{5,}/.test(last)) return true; // numeric story id
  return last.length >= 24 && (last.match(/-/g) || []).length >= 3;
}

function imgSrc($img) {
  if (!$img || !$img.length) return '';
  const cand =
    $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('data-original') || $img.attr('data-srcset')?.split(/[\s,]+/)[0] ||
    $img.attr('srcset')?.split(/[\s,]+/)[0] || $img.attr('src') || '';
  if (!cand || cand.startsWith('data:') || /blank|placeholder|spacer|lazy|default\.(gif|png)|1x1/i.test(cand)) return '';
  return cand;
}

export async function scrapeListing(pageUrl, limit = 18) {
  const html = await fetchText(pageUrl, 10000);
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);
  const host = base.hostname.replace(/^www\./, '');
  const found = new Map();

  $('a[href]').each((_, a) => {
    let u;
    try {
      u = new URL($(a).attr('href'), base);
    } catch {
      return;
    }
    if (u.hostname.replace(/^www\./, '') !== host || !/^https?:$/.test(u.protocol)) return;
    if (!looksLikeArticle(u.pathname)) return;
    if (base.pathname.replace(/\/$/, '').startsWith(u.pathname.replace(/\/$/, ''))) return; // the listing page itself
    const key = `${u.origin}${u.pathname}`;
    const $a = $(a);
    const $img = $a.find('img').first().length ? $a.find('img').first() : $a.closest('article, li, figure, .card, .story, .news-card').find('img').first();
    const title = stripHtml($a.attr('title') || $a.text() || $a.find('img').attr('alt') || '').slice(0, 220);
    const image = imgSrc($img);
    const prev = found.get(key);
    if (prev) {
      if (title.length > prev.title.length) prev.title = title;
      if (!prev.image && image) prev.image = image;
    } else {
      found.set(key, { link: key, title, image: image ? new URL(image, base).href : '' });
    }
  });

  return [...found.values()].slice(0, limit);
}
