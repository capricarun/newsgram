// Paste-a-link video grabber built on yt-dlp (YouTube, X, Instagram, Facebook,
// and ~1,800 other sites). Downloads run as background jobs so the browser
// can poll progress.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPublicUrl } from './util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let cachedBin;
export function ytdlpPath() {
  if (cachedBin !== undefined) return cachedBin;
  const candidates = [process.env.YTDLP_PATH, path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'), 'yt-dlp'].filter(Boolean);
  cachedBin = null;
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 15000 });
      if (r.status === 0) {
        cachedBin = c;
        break;
      }
    } catch {}
  }
  return cachedBin;
}

export function ytdlpVersion() {
  const bin = ytdlpPath();
  if (!bin) return null;
  return spawnSync(bin, ['--version']).stdout?.toString().trim() || null;
}

// Optional cookies (Netscape format) for sites that need a login — e.g. Instagram,
// or YouTube when it blocks cloud servers. Set YTDLP_COOKIES (file contents) or YTDLP_COOKIES_FILE.
function cookieArgs() {
  if (process.env.YTDLP_COOKIES_FILE) return ['--cookies', process.env.YTDLP_COOKIES_FILE];
  if (process.env.YTDLP_COOKIES) {
    const file = path.join(os.tmpdir(), 'newsgram-cookies.txt');
    if (!fs.existsSync(file)) fs.writeFileSync(file, process.env.YTDLP_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
    return ['--cookies', file];
  }
  return [];
}

export function platformOf(url) {
  const h = new URL(url).hostname.replace(/^(www|m|mobile)\./, '');
  if (/youtube\.com|youtu\.be/.test(h)) return 'YouTube';
  if (/(^|\.)x\.com$|twitter\.com/.test(h)) return 'X';
  if (/instagram\.com/.test(h)) return 'Instagram';
  if (/facebook\.com|fb\.watch/.test(h)) return 'Facebook';
  if (/sharechat|mojapp/.test(h)) return 'ShareChat';
  return h;
}

function friendlyError(stderr, url) {
  const line = (stderr.match(/ERROR:.*$/m) || [stderr.trim().split('\n').pop() || 'Download failed'])[0].replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '');
  const p = (() => {
    try {
      return platformOf(url);
    } catch {
      return '';
    }
  })();
  if (/confirm you.?re not a bot|sign in to confirm/i.test(line))
    return `${p} is blocking downloads from this server. Try from Newsgram running on your own computer, or add YTDLP_COOKIES (see README).`;
  if (/login required|rate-limit|requested content is not available|empty media response|not logged in/i.test(line))
    return `${p} needs a logged-in session for this post. Add YTDLP_COOKIES (see README), or the post may be private.`;
  if (/unable to (download|connect)|proxy|timed out|network is unreachable|getaddrinfo|connection (reset|refused)/i.test(line))
    return `Couldn't reach ${p} from this server right now. Check the link, or try again in a minute.`;
  if (/unsupported url/i.test(line)) return 'This link isn\'t a supported video page. Open the post itself and copy its link.';
  if (/no video could be found|no video formats found/i.test(line)) return 'No video in that post — it may be an image or text post.';
  if (/max-filesize|larger than max/i.test(line)) return 'That video is over 500 MB. Pick a lower quality.';
  return line.slice(0, 300);
}

function run(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(ytdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

async function checkUrl(url) {
  if (!ytdlpPath()) throw Object.assign(new Error('yt-dlp is not installed on the server. Run: npm run update-ytdlp'), { status: 503 });
  if (process.env.MOCK === '1') return new URL(url).href; // allows local test files
  const u = await assertPublicUrl(url);
  return u.href;
}

export async function grabInfo(rawUrl) {
  const url = await checkUrl(rawUrl);
  const r = await run(['-J', '--no-playlist', '--no-warnings', ...cookieArgs(), url], 60000);
  if (r.code !== 0) throw Object.assign(new Error(friendlyError(r.err, url)), { status: 422 });
  let info = JSON.parse(r.out);
  if (info._type === 'playlist' && info.entries?.length) info = info.entries.find((e) => e.formats?.length) || info.entries[0];
  const formats = info.formats || [];
  const heights = [...new Set(formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))].sort((a, b) => b - a);
  const hasVideo = heights.length > 0 || formats.some((f) => f.vcodec && f.vcodec !== 'none') || Boolean(info.url && info.ext === 'mp4');
  return {
    url,
    platform: platformOf(url),
    title: (info.title || info.description || 'Untitled video').slice(0, 200),
    description: (info.description || '').slice(0, 800),
    uploader: info.uploader || info.channel || info.uploader_id || '',
    duration: info.duration || null,
    thumbnail: info.thumbnail || info.thumbnails?.at(-1)?.url || '',
    width: info.width || null,
    height: info.height || null,
    heights,
    hasVideo,
    filesize: info.filesize || info.filesize_approx || null,
  };
}

const jobs = new Map();

function formatFor(quality) {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'mp3'];
  const h = Number(quality);
  const cap = h ? `[height<=${h}]` : '';
  // Prefer H.264 + AAC (plays everywhere, Instagram-friendly), fall back to anything.
  return ['-f', `bv*${cap}[vcodec^=avc1]+ba[ext=m4a]/b${cap}[vcodec^=avc1]/bv*${cap}+ba/b${cap}/b`, '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
}

export async function startGrab(rawUrl, quality, mediaDir, ffmpegPath) {
  const url = await checkUrl(rawUrl);
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, url, quality, status: 'running', stage: 'starting', progress: 0, file: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);

  const args = [
    '--no-playlist', '--newline', '--no-warnings', '--no-part', '--restrict-filenames',
    '--max-filesize', '500M',
    ...formatFor(quality),
    ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
    '-o', path.join(mediaDir, `grab-${id}.%(ext)s`),
    '--print', 'after_move:filepath', '--no-simulate',
    ...cookieArgs(),
    url,
  ];
  const p = spawn(ytdlpPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const killer = setTimeout(() => p.kill('SIGKILL'), 15 * 60 * 1000);
  let err = '';
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        job.progress = Math.min(99, Number(m[1]));
        job.stage = 'downloading';
      } else if (/\[(Merger|VideoRemuxer|ExtractAudio|FixupM3u8|VideoConvertor)\]/.test(line)) {
        job.stage = 'processing';
      } else if (line.startsWith(mediaDir) || line.includes(`grab-${id}.`)) {
        job.file = path.basename(line.trim());
      }
    }
  });
  p.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
  p.on('close', (code) => {
    clearTimeout(killer);
    if (!job.file) {
      const f = fs.readdirSync(mediaDir).find((n) => n.startsWith(`grab-${id}.`));
      if (f) job.file = f;
    }
    if (code === 0 && job.file && fs.existsSync(path.join(mediaDir, job.file))) {
      job.status = 'done';
      job.progress = 100;
      job.stage = 'done';
      job.size = fs.statSync(path.join(mediaDir, job.file)).size;
    } else {
      job.status = 'error';
      job.error = friendlyError(err || 'Download failed', url);
    }
  });
  return job;
}

export function grabJob(id) {
  return jobs.get(id) || null;
}

// Forget finished jobs after a day (files are cleaned by the media sweeper).
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, j] of jobs) if (j.startedAt < cutoff) jobs.delete(id);
}, 3600 * 1000).unref();
