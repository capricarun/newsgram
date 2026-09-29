import * as cheerio from 'cheerio';
import { cached, fetchText, stripHtml, assertPublicUrl } from './util.js';
import { mockArticle } from './mock.js';

function abs(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
}

function walkJsonLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, out));
  const type = [].concat(node['@type'] || []).join(',');
  if (/Article|NewsArticle|LiveBlogPosting/i.test(type)) {
    if (node.articleBody && !out.body) out.body = stripHtml(node.articleBody);
    if (node.datePublished && !out.published) out.published = node.datePublished;
    const img = [].concat(node.image || []).map((i) => (typeof i === 'string' ? i : i?.url)).filter(Boolean);
    out.images.push(...img);
    if (node.video) walkJsonLd(node.video, out);
  }
  if (/VideoObject/i.test(type)) {
    if (node.contentUrl) out.videos.push({ url: node.contentUrl, type: 'file' });
    else if (node.embedUrl) out.videos.push({ url: node.embedUrl, type: 'embed' });
  }
  if (node['@graph']) walkJsonLd(node['@graph'], out);
}

/**
 * Pulls the headline, lead image, readable body text and any video from an article page.
 * `lite` skips body extraction (used when we only need the image for the news grid).
 */
export async function getArticle(url, { lite = false } = {}) {
  if (process.env.MOCK === '1') return mockArticle(url);
  await assertPublicUrl(url);
  return cached(`art:${lite}:${url}`, 15 * 60 * 1000, async () => {
    const html = await fetchText(url, lite ? 7000 : 12000);
    const $ = cheerio.load(html);
    const meta = (sel) => $(sel).attr('content')?.trim() || '';

    const out = { images: [], videos: [], body: '' };
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        walkJsonLd(JSON.parse($(el).contents().text()), out);
      } catch {}
    });

    const ogImage = meta('meta[property="og:image:secure_url"]') || meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]');
    const images = [ogImage, ...out.images].map((u) => abs(u, url)).filter(Boolean);

    const ogVideo =
      meta('meta[property="og:video:secure_url"]') || meta('meta[property="og:video:url"]') || meta('meta[property="og:video"]') ||
      meta('meta[name="twitter:player:stream"]');
    const videos = [];
    if (ogVideo) videos.push({ url: abs(ogVideo, url), type: 'file' });
    $('video[src], video source[src]').each((_, el) => videos.push({ url: abs($(el).attr('src'), url), type: 'file' }));
    videos.push(...out.videos.map((v) => ({ ...v, url: abs(v.url, url) })));
    const uniqVideos = [...new Map(videos.filter((v) => v.url).map((v) => [v.url, v])).values()].map((v) => ({
      ...v,
      type: v.type === 'embed' || /youtube|youtu\.be|jwplayer|embed|player/i.test(v.url) ? 'embed' : /\.m3u8/i.test(v.url) ? 'stream' : 'file',
    }));

    const result = {
      url,
      title: meta('meta[property="og:title"]') || $('title').text().trim(),
      description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
      image: images[0] || '',
      published: (() => {
        const d = new Date(meta('meta[property="article:published_time"]') || meta('meta[name="publish-date"]') || meta('meta[itemprop="datePublished"]') || out.published || '');
        return isNaN(d) ? '' : d.toISOString();
      })(),
      images: [...new Set(images)].slice(0, 8),
      videos: uniqVideos.slice(0, 5),
      text: '',
    };
    if (lite) return result;

    let body = out.body;
    if (!body || body.length < 300) {
      const containers = ['[itemprop="articleBody"]', 'article', '.articlebodycontent', '.story-details', '.full-details', '.article-body', '.storyDetails', 'main'];
      for (const sel of containers) {
        const paras = $(sel)
          .first()
          .find('p')
          .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter((p) => p.length > 40 && !/subscribe|also read|follow us|download the app|click here/i.test(p));
        if (paras.join(' ').length > (body?.length || 0)) body = paras.join('\n\n');
        if (body && body.length > 800) break;
      }
    }
    result.text = (body || result.description || '').slice(0, 7000);
    return result;
  });
}
