// Instagram Content Publishing API.
// Instagram fetches the media itself, so the file must sit at a public HTTPS URL
// (PUBLIC_BASE_URL) — that's why posting only works once the app is deployed or tunnelled.

const host = () => process.env.IG_GRAPH_HOST || 'graph.facebook.com';
const ver = () => process.env.IG_GRAPH_VERSION || 'v25.0';

export const igEnabled = () => Boolean(process.env.IG_USER_ID && process.env.IG_ACCESS_TOKEN && process.env.PUBLIC_BASE_URL);

async function graph(method, path, params = {}) {
  const url = new URL(`https://${host()}/${ver()}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  let res;
  if (method === 'GET') {
    body.forEach((v, k) => url.searchParams.set(k, v));
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data?.error?.error_user_msg || data?.error?.message || `Graph API ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function publishToInstagram({ kind, mediaUrl, caption }) {
  if (!igEnabled()) throw new Error('Instagram is not configured (IG_USER_ID, IG_ACCESS_TOKEN, PUBLIC_BASE_URL).');
  const ig = process.env.IG_USER_ID;
  const params = kind === 'video'
    ? { media_type: 'REELS', video_url: mediaUrl, caption, share_to_feed: 'true' }
    : { image_url: mediaUrl, caption };
  const container = await graph('POST', `${ig}/media`, params);

  // Wait for Instagram to finish processing (videos can take a while).
  const deadline = Date.now() + (kind === 'video' ? 180000 : 30000);
  for (;;) {
    const s = await graph('GET', container.id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Instagram rejected the media: ${s.status || s.status_code}`);
    if (Date.now() > deadline) throw new Error('Instagram is still processing the media — try publishing again in a minute.');
    await sleep(kind === 'video' ? 4000 : 1500);
  }

  const published = await graph('POST', `${ig}/media_publish`, { creation_id: container.id });
  let permalink = '';
  try {
    permalink = (await graph('GET', published.id, { fields: 'permalink' })).permalink;
  } catch {}
  return { id: published.id, permalink };
}
