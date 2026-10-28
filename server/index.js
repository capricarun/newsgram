import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SOURCES, CATEGORIES } from './sources.js';
import { getNews } from './news.js';
import { searchNews } from './search.js';
import { getArticle } from './article.js';
import { rephraseBatch, rephraseArticle, aiEnabled } from './ai.js';
import { publishToInstagram, igEnabled } from './instagram.js';
import { assertPublicUrl, fetchWithTimeout } from './util.js';
import { mockImageSvg } from './mock.js';
import { grabInfo, startGrab, grabJob, ytdlpPath, ytdlpVersion } from './grab.js';
import { probe, startEdit, editJob, startProject, thumbStrip } from './edit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MEDIA_DIR = path.join(ROOT, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) {
  try {
    ffmpegPath = (await import('ffmpeg-static')).default;
  } catch {}
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.send('ok'));

// Password gate (APP_PASSWORD). /media stays public because Instagram downloads posts from there.
app.use((req, res, next) => {
  const pass = process.env.APP_PASSWORD;
  if (!pass || req.path.startsWith('/media/')) return next();
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && value) {
    const supplied = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(supplied);
    const b = Buffer.from(pass);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Newsgram", charset="UTF-8"').status(401).send('Password required');
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h' }));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(`[${req.method} ${req.path}]`, e.message);
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  });

const isMock = () => process.env.MOCK === '1';

app.get('/api/config', (req, res) => {
  res.json({
    sources: SOURCES.map(({ id, name, color, x, domain, group, lang, only }) => ({ id, name, color, x, domain, group, lang, only: only || null })),
    categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
    features: { ai: aiEnabled(), instagram: igEnabled(), x: Boolean(process.env.X_BEARER_TOKEN), transcode: Boolean(ffmpegPath), grab: Boolean(ytdlpPath()), mock: isMock() },
    handle: process.env.BRAND_HANDLE || '',
  });
});

app.get('/api/news', wrap(async (req, res) => {
  const sourceIds = String(req.query.sources || '').split(',').filter(Boolean);
  const category = String(req.query.category || 'top');
  if (!sourceIds.length) return res.status(400).json({ error: 'Pick at least one source' });
  res.json(await getNews({ sourceIds, category, includeX: req.query.x === '1' }));
}));

app.get('/api/search', wrap(async (req, res) => {
  const sourceIds = String(req.query.sources || '').split(',').filter(Boolean);
  res.json(await searchNews({ q: req.query.q, sourceIds, scope: String(req.query.scope || 'selected'), range: String(req.query.range || '7d'), category: String(req.query.category || 'top') }));
}));

app.get('/api/article', wrap(async (req, res) => {
  res.json(await getArticle(String(req.query.url || '')));
}));

app.post('/api/ai/headlines', wrap(async (req, res) => {
  const { items = [], tone, lang } = req.body || {};
  res.json(await rephraseBatch(items.slice(0, 24), { tone, lang }));
}));

app.post('/api/ai/rephrase', wrap(async (req, res) => {
  const { url, title, summary, sourceName, tone, lang, handle } = req.body || {};
  // "Your own story": the user's pasted copy is the source text.
  const own = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 12000) : '';
  let text = own;
  if (own) {
    // nothing to fetch
  } else if (url && !/^\//.test(url)) {
    try {
      text = (await getArticle(url)).text;
    } catch (e) {
      console.warn('article fetch failed, using summary:', e.message);
    }
  } else if (isMock()) {
    text = (await getArticle(url || '')).text;
  }
  res.json({ ...(await rephraseArticle({ title, summary, text, sourceName, tone, lang, handle, own: Boolean(own) })), usedArticle: Boolean(text) });
}));

// Same-origin image proxy so the canvas isn't tainted by cross-origin images.
app.get('/api/img', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  await assertPublicUrl(url);
  const r = await fetchWithTimeout(url, { headers: { Referer: new URL(url).origin + '/' } }, 15000);
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) return res.status(502).json({ error: `Image fetch failed (${r.status})` });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20e6) return res.status(413).end();
  res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' }).send(buf);
}));

app.get('/api/mock-image/:n', (req, res) => res.type('image/svg+xml').send(mockImageSvg(Number(req.params.n) || 0)));

// Streams a source video to the browser as a download.
app.get('/api/video', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (url.startsWith('/media/')) return res.download(path.join(MEDIA_DIR, path.basename(url)));
  await assertPublicUrl(url);
  const r = await fetchWithTimeout(url, { headers: { Referer: new URL(url).origin + '/' } }, 60000);
  const type = r.headers.get('content-type') || '';
  if (!r.ok) return res.status(502).json({ error: `Video fetch failed (${r.status})` });
  if (!/video|octet-stream|mp4/.test(type)) return res.status(415).json({ error: `Not a direct video file (${type || 'unknown type'}). It may be a stream or embedded player.` });
  const name = (String(req.query.name || 'news-video').replace(/[^\w-]+/g, '-').slice(0, 60) || 'news-video') + '.mp4';
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
  if (r.headers.get('content-length')) res.set('Content-Length', r.headers.get('content-length'));
  Readable.fromWeb(r.body).pipe(res);
}));

// Saves a rendered card / reel so it has a public URL (needed by Instagram).
const MEDIA_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/3gpp': '3gp',
  'video/x-msvideo': 'avi', 'video/mpeg': 'mpg', 'video/x-m4v': 'm4v', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
};

const MAX_UPLOAD = 300e6;
// Streams the upload straight to disk (holding it in memory can crash a small server).
function saveUpload(req, dest) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(dest);
    const fail = (e) => {
      out.destroy();
      fs.rmSync(dest, { force: true });
      reject(e);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.unpipe(out);
        req.resume(); // drain the rest
        fail(Object.assign(new Error('That file is over 300 MB.'), { status: 413 }));
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Upload was interrupted.')));
    out.on('error', fail);
    out.on('finish', () => (size ? resolve(size) : fail(Object.assign(new Error('The upload was empty.'), { status: 400 }))));
    req.pipe(out);
  });
}

app.post('/api/media', wrap(async (req, res) => {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[type] || null;
  if (!ext) return res.status(400).json({ error: 'Unsupported media' });
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return res.status(413).json({ error: 'That file is over 300 MB.' });
  let name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await saveUpload(req, path.join(MEDIA_DIR, name));
  // Instagram needs H.264 MP4 — transcode anything else (or re-mux MediaRecorder MP4 for safety).
  // ?raw=1 keeps the upload as-is (e.g. a video we only want the sound from).
  if (type.startsWith('video/') && ffmpegPath && req.query.raw !== '1' && (ext === 'webm' || req.query.normalize === '1')) {
    const out = name.replace(/\.\w+$/, '-ig.mp4');
    await transcode(path.join(MEDIA_DIR, name), path.join(MEDIA_DIR, out), req.query.audio === 'optional' ? 'optional' : req.query.audio === '1');
    fs.rmSync(path.join(MEDIA_DIR, name), { force: true });
    name = out;
  }
  cleanupMedia();
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.json({ name, path: `/media/${name}`, url: `${base}/media/${name}` });
}));

// Pulls the sound track out of an uploaded video as an MP3.
const BITRATES = new Set(['128', '192', '256', '320']);
app.post('/api/audio/extract', wrap(async (req, res) => {
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this server.');
  const src = mediaFile(req.body?.name);
  const kbps = BITRATES.has(String(req.body?.bitrate)) ? String(req.body.bitrate) : '192';
  const out = path.basename(src).replace(/\.\w+$/, '') + '-audio.mp3';
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-hide_banner', '-i', src, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-ar', '44100', path.join(MEDIA_DIR, out)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.on('error', (e) => reject(new Error(`ffmpeg couldn't start: ${e.message}`)));
    p.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      if (/matches no streams|does not contain any stream/i.test(err)) return reject(Object.assign(new Error('This video has no sound track to extract.'), { status: 422 }));
      reject(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
  fs.rmSync(src, { force: true }); // the uploaded video isn't needed any more
  const size = fs.statSync(path.join(MEDIA_DIR, out)).size;
  res.json({ name: out, path: `/media/${out}`, size });
}));

// Photos (iPhone) only keeps pictures and videos: wrap an audio file in a simple waveform video.
app.post('/api/audio/tovideo', wrap(async (req, res) => {
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this server.');
  const src = mediaFile(req.body?.name);
  const out = path.basename(src).replace(/\.\w+$/, '') + '-photos.mp4';
  const args = ['-y', '-hide_banner',
    '-f', 'lavfi', '-i', 'color=c=0x0B0B10:s=720x720:r=15',
    '-i', src,
    '-filter_complex', '[1:a]aformat=channel_layouts=mono,showwaves=s=720x260:mode=cline:rate=15:colors=0xC6FF3D[w];[0:v][w]overlay=0:230:shortest=1,format=yuv420p[v]',
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-shortest', '-movflags', '+faststart', path.join(MEDIA_DIR, out)];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.on('error', (e) => reject(new Error(`ffmpeg couldn't start: ${e.message}`)));
    p.stderr.on('data', (d) => (err = (err + d).slice(-3000)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
  });
  fs.rmSync(src, { force: true });
  res.json({ name: out, path: `/media/${out}` });
}));

function transcode(input, output, hasAudio = false) {
  return new Promise((resolve, reject) => {
    // Instagram wants H.264 + AAC; add a silent track when the reel has no music.
    const audioIn =
      hasAudio === 'optional' ? ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(min(iw\\,1920)/2)*2:-2']
      : hasAudio ? ['-map', '0:v:0', '-map', '0:a:0']
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-map', '0:v:0', '-map', '1:a:0', '-shortest'];
    const args = ['-y', '-i', input, ...audioIn,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-r', '30', '-b:v', '5M', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-movflags', '+faststart', output];
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.on('error', (e) => reject(new Error(`ffmpeg couldn't start: ${e.message}`)));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.split('\n').slice(-3).join(' ')}`))));
  });
}

function cleanupMedia() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (f === 'sample.mp4' || f.startsWith('.')) continue;
    const p = path.join(MEDIA_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}

/* ---------- paste-a-link video grabber ---------- */
app.post('/api/grab/info', wrap(async (req, res) => {
  res.json(await grabInfo(String(req.body?.url || '').trim()));
}));

app.post('/api/grab/start', wrap(async (req, res) => {
  const { url, quality = 'best' } = req.body || {};
  const job = await startGrab(String(url || '').trim(), String(quality), MEDIA_DIR, ffmpegPath);
  cleanupMedia();
  res.json({ id: job.id });
}));

app.get('/api/grab/:id', (req, res) => {
  const j = grabJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown or expired download' });
  res.json({ id: j.id, status: j.status, stage: j.stage, progress: j.progress, error: j.error, file: j.file, size: j.size || null });
});

app.get('/api/grab/:id/file', (req, res) => {
  const j = grabJob(req.params.id);
  if (!j?.file) return res.status(404).json({ error: 'Not ready' });
  const ext = path.extname(j.file);
  const name = (String(req.query.name || 'video').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video') + ext;
  res.download(path.join(MEDIA_DIR, j.file), name);
});

/* ---------- video editor: crop / trim / music ---------- */
const mediaFile = (name) => {
  const f = path.join(MEDIA_DIR, path.basename(String(name || '')));
  if (!name || !fs.existsSync(f)) throw Object.assign(new Error('File not found — it may have expired. Download or upload it again.'), { status: 404 });
  return f;
};

app.post('/api/video/probe', wrap(async (req, res) => {
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this server.');
  res.json(await probe(ffmpegPath, mediaFile(req.body?.name)));
}));

app.post('/api/video/edit', wrap(async (req, res) => {
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this server.');
  const b = req.body || {};
  let musicPath = null;
  if (b.music && b.music !== 'none') {
    musicPath = b.music === 'custom'
      ? mediaFile(b.musicFile)
      : path.join(ROOT, 'public', 'music', `${path.basename(String(b.music)).replace(/[^\w-]/g, '')}.mp3`);
  }
  const { job } = await startEdit(ffmpegPath, MEDIA_DIR, {
    source: path.basename(mediaFile(b.source)),
    crop: b.crop, aspect: b.aspect, start: b.start, end: b.end, musicPath, musicVol: b.musicVol, origVol: b.origVol, maxWidth: b.maxWidth,
  });
  cleanupMedia();
  res.json({ id: job.id });
}));

const musicPathFor = (m) => {
  if (!m || !m.id || m.id === 'none') return null;
  if (m.id === 'custom') return mediaFile(m.file);
  return path.join(ROOT, 'public', 'music', `${path.basename(String(m.id)).replace(/[^\w-]/g, '')}.mp3`);
};

app.post('/api/video/render', wrap(async (req, res) => {
  if (!ffmpegPath) throw new Error('ffmpeg is not available on this server.');
  const b = req.body || {};
  const job = await startProject(ffmpegPath, MEDIA_DIR, {
    frame: b.frame,
    clips: b.clips,
    muteAll: Boolean(b.muteAll),
    music: b.music ? { ...b.music, path: musicPathFor(b.music) } : null,
  });
  cleanupMedia();
  res.json({ id: job.id });
}));

app.get('/api/video/thumbs/:name', wrap(async (req, res) => {
  if (!ffmpegPath) return res.status(404).end();
  const file = await thumbStrip(ffmpegPath, MEDIA_DIR, path.basename(mediaFile(req.params.name)));
  res.set('Cache-Control', 'public, max-age=86400').sendFile(file);
}));

app.get('/api/video/edit/:id', (req, res) => {
  const j = editJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Unknown or expired render' });
  res.json({ id: j.id, status: j.status, progress: j.progress, error: j.error, file: j.file, size: j.size || null, width: j.width, height: j.height, duration: j.duration });
});

app.get('/api/video/edit/:id/file', (req, res) => {
  const j = editJob(req.params.id);
  if (!j?.file) return res.status(404).json({ error: 'Not ready' });
  const name = (String(req.query.name || 'video').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video') + '-edited.mp4';
  res.download(path.join(MEDIA_DIR, j.file), name);
});

app.post('/api/instagram/publish', wrap(async (req, res) => {
  const { kind, caption = '' } = req.body || {};
  let name = path.basename(String(req.body?.name || ''));
  if (!name || !fs.existsSync(path.join(MEDIA_DIR, name))) return res.status(400).json({ error: 'Upload the media first' });
  // Grabbed videos can be VP9/AV1/odd sizes — convert to Instagram's H.264/AAC first.
  if (kind === 'video' && name.startsWith('grab-')) {
    if (!ffmpegPath) throw new Error('ffmpeg is needed to prepare this video for Instagram.');
    const out = name.replace(/\.\w+$/, '-ig.mp4');
    if (!fs.existsSync(path.join(MEDIA_DIR, out))) await transcode(path.join(MEDIA_DIR, name), path.join(MEDIA_DIR, out), 'optional');
    name = out;
  }
  const mediaUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${name}`;
  res.json(await publishToInstagram({ kind, mediaUrl, caption: caption.slice(0, 2200) }));
}));

const BASE_PORT = Number(process.env.PORT) || 3000;

// Starts on PORT (default 3000); if it's taken locally, tries the next few ports.
function start(port, triesLeft) {
  app.listen(port, (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE' && triesLeft > 0 && !process.env.RENDER) {
        console.log(`  Port ${port} is busy, trying ${port + 1}…`);
        return start(port + 1, triesLeft - 1);
      }
      console.error(err.code === 'EADDRINUSE' ? `\n  Port ${port} is already in use. Try: PORT=4000 npm start\n` : err);
      process.exit(1);
    }
    console.log(`\n  Newsgram running → http://localhost:${port}`);
    if (!ytdlpPath()) console.log('  Video grabber: off (run npm run update-ytdlp)');
    console.log(`  AI rephrase: ${aiEnabled() ? 'on' : 'off (set ANTHROPIC_API_KEY)'} · Instagram: ${igEnabled() ? 'on' : 'off'} · X: ${process.env.X_BEARER_TOKEN ? 'on' : 'off'} · ffmpeg: ${ffmpegPath ? 'yes' : 'no'}${isMock() ? ' · MOCK DATA' : ''}\n`);
  });
}
start(BASE_PORT, 10);
