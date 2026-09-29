import { cached, fetchWithTimeout } from './util.js';

const API = 'https://api.x.com/2';

async function xGet(path) {
  const res = await fetchWithTimeout(`${API}${path}`, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.title || data?.detail || `X API ${res.status}`);
  return data;
}

/** Latest posts (with photos / video variants) from a publisher's official X account. Needs X_BEARER_TOKEN. */
export async function fetchXPosts(source) {
  if (!process.env.X_BEARER_TOKEN) throw new Error('X_BEARER_TOKEN not set');
  return cached(`x:${source.x}`, 10 * 60 * 1000, async () => {
    const user = await cached(`xuser:${source.x}`, 24 * 3600 * 1000, () => xGet(`/users/by/username/${source.x}`));
    const id = user?.data?.id;
    if (!id) throw new Error(`X user @${source.x} not found`);
    const data = await xGet(
      `/users/${id}/tweets?max_results=10&exclude=replies,retweets&tweet.fields=created_at,entities&expansions=attachments.media_keys&media.fields=url,preview_image_url,type,variants,width,height`,
    );
    const media = new Map((data.includes?.media || []).map((m) => [m.media_key, m]));
    return (data.data || []).map((t) => {
      const ms = (t.attachments?.media_keys || []).map((k) => media.get(k)).filter(Boolean);
      const photo = ms.find((m) => m.type === 'photo');
      const vid = ms.find((m) => m.type === 'video' || m.type === 'animated_gif');
      const best = vid?.variants?.filter((v) => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
      const link = t.entities?.urls?.find((u) => !/x\.com|twitter\.com/.test(u.expanded_url))?.expanded_url || '';
      const textClean = t.text.replace(/https:\/\/t\.co\/\S+/g, '').trim();
      return {
        id: `x${t.id}`,
        kind: 'x',
        via: 'x',
        sourceId: source.id,
        sourceName: `@${source.x}`,
        sourceColor: source.color,
        title: textClean.split('\n')[0].slice(0, 160),
        summary: textClean,
        link: link || `https://x.com/${source.x}/status/${t.id}`,
        postUrl: `https://x.com/${source.x}/status/${t.id}`,
        image: photo?.url || vid?.preview_image_url || '',
        video: best?.url || '',
        published: t.created_at,
      };
    });
  });
}
