// Video editor: crop (top/bottom/left/right), trim, and mix in music — rendered with ffmpeg
// as a background job the browser polls for progress.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const jobs = new Map();

function parseTime(s) {
  const m = String(s).match(/(\d+):(\d+):([\d.]+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Reads width/height/duration/audio presence from ffmpeg's banner (ffprobe isn't bundled). */
export function probe(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const v = err.match(/Stream #\S+.*Video:.*?(\d{2,5})x(\d{2,5})/);
      const dur = err.match(/Duration:\s*(\d+:\d+:[\d.]+)/);
      const rot = err.match(/rotation of (-?\d+)|rotate\s*:\s*(-?\d+)/);
      if (!v) return reject(new Error('That file has no video track.'));
      let width = Number(v[1]);
      let height = Number(v[2]);
      const r = Math.abs(Number(rot?.[1] || rot?.[2] || 0));
      if (r === 90 || r === 270) [width, height] = [height, width]; // phone videos
      resolve({ width, height, duration: dur ? parseTime(dur[1]) : 0, hasAudio: /Stream #\S+.*Audio:/.test(err) });
    });
    p.on('error', reject);
  });
}

const clampPct = (v) => Math.max(0, Math.min(90, Number(v) || 0));
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * opts: { source, crop:{top,bottom,left,right} (percent), start, end (seconds),
 *         musicPath|null, musicVol (0-1.5), origVol (0-1.5), maxWidth }
 */
export async function startEdit(ffmpegPath, mediaDir, opts) {
  const src = path.join(mediaDir, path.basename(opts.source));
  if (!fs.existsSync(src)) throw Object.assign(new Error('Source video not found — download or upload it again.'), { status: 404 });
  const info = await probe(ffmpegPath, src);

  const c = { top: clampPct(opts.crop?.top), bottom: clampPct(opts.crop?.bottom), left: clampPct(opts.crop?.left), right: clampPct(opts.crop?.right) };
  // Always keep at least 10% of the frame in each direction.
  if (c.left + c.right > 90) c.right = 90 - c.left;
  if (c.top + c.bottom > 90) c.bottom = 90 - c.top;
  const cw = even(info.width * (1 - (c.left + c.right) / 100));
  const ch = even(info.height * (1 - (c.top + c.bottom) / 100));
  const cx = Math.round((info.width * c.left) / 100);
  const cy = Math.round((info.height * c.top) / 100);
  const maxW = Number(opts.maxWidth) || 1920;

  const start = Math.max(0, Number(opts.start) || 0);
  const end = Math.min(info.duration || Infinity, Number(opts.end) || info.duration || Infinity);
  const dur = Math.max(0.5, (isFinite(end) ? end : info.duration) - start);
  if (dur > 15 * 60) throw Object.assign(new Error('Keep edits under 15 minutes (Instagram Reels limit).'), { status: 400 });

  const musicVol = Math.max(0, Math.min(1.5, Number(opts.musicVol ?? 0.8)));
  const origVol = info.hasAudio ? Math.max(0, Math.min(1.5, Number(opts.origVol ?? 1))) : 0;
  const music = opts.musicPath && fs.existsSync(opts.musicPath) && musicVol > 0 ? opts.musicPath : null;

  const args = ['-y', '-hide_banner', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src];
  if (music) args.push('-stream_loop', '-1', '-i', music);

  const fadeOut = Math.max(0, dur - 1.2).toFixed(3);
  // Frame presets render at Instagram's exact sizes; free crops keep their shape.
  const PRESET = { '1:1': [1080, 1080], '9:16': [1080, 1920], '4:5': [1080, 1350], '16:9': [1920, 1080] }[opts.aspect];
  const scale = PRESET ? `scale=${PRESET[0]}:${PRESET[1]}:flags=lanczos` : `scale='max(720,min(${maxW},iw))':-2:flags=lanczos`;
  const vf = `[0:v]crop=${cw}:${ch}:${cx}:${cy},${scale},setsar=1,format=yuv420p[v]`;
  let af = '';
  if (music && origVol > 0) {
    af = `;[0:a]volume=${origVol}[a0];[1:a]volume=${musicVol},afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1.2[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
  } else if (music) {
    af = `;[1:a]volume=${musicVol},afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1.2,atrim=0:${dur.toFixed(3)}[a]`;
  } else if (origVol > 0) {
    af = `;[0:a]volume=${origVol}[a]`;
  } else {
    af = `;anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:${dur.toFixed(3)}[a]`;
  }

  const id = crypto.randomBytes(6).toString('hex');
  const out = path.join(mediaDir, `edit-${id}.mp4`);
  args.push(
    '-filter_complex', vf + af,
    '-map', '[v]', '-map', '[a]',
    '-t', dur.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out,
  );

  const job = { id, status: 'running', progress: 0, file: null, error: null, startedAt: Date.now(), width: PRESET ? PRESET[0] : Math.max(720, Math.min(cw, maxW)), height: PRESET ? PRESET[1] : 0, duration: dur };
  jobs.set(id, job);
  const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const killer = setTimeout(() => p.kill('SIGKILL'), 20 * 60 * 1000);
  let err = '';
  p.stdout.on('data', (d) => {
    const m = String(d).match(/out_time_ms=(\d+)/g);
    if (m) job.progress = Math.min(99, (Number(m.at(-1).split('=')[1]) / 1e6 / dur) * 100);
  });
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  p.on('close', (code) => {
    clearTimeout(killer);
    if (code === 0 && fs.existsSync(out)) {
      job.status = 'done';
      job.progress = 100;
      job.file = path.basename(out);
      job.size = fs.statSync(out).size;
      if (!job.height) job.height = Math.round((job.width * ch) / cw / 2) * 2;
    } else {
      job.status = 'error';
      job.error = `Rendering failed: ${err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`;
    }
  });
  return { job, info };
}

export function editJob(id) {
  return jobs.get(id) || null;
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, j] of jobs) if (j.startedAt < cutoff) jobs.delete(id);
}, 3600 * 1000).unref();
