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

/* ================= multi-clip timeline render ================= */

const FRAMES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

/**
 * project: {
 *   frame: 'original'|'9:16'|'1:1'|'4:5'|'16:9',
 *   clips: [{ name, in, out, crop:{top,bottom,left,right}, mode:'fill'|'fit', zoom, panX, panY, volume }],
 *   music: { path|null, volume, loop, offset, in } , muteAll
 * }
 */
export async function startProject(ffmpegPath, mediaDir, project) {
  const clipsIn = (project.clips || []).slice(0, 30);
  if (!clipsIn.length) throw Object.assign(new Error('Add at least one clip.'), { status: 400 });

  const clips = [];
  for (const c of clipsIn) {
    const file = path.join(mediaDir, path.basename(String(c.name || '')));
    if (!fs.existsSync(file)) throw Object.assign(new Error(`Clip "${c.name}" has expired — add it again.`), { status: 404 });
    const info = await probe(ffmpegPath, file);
    const cin = num(c.in, 0, Math.max(0, info.duration - 0.2), 0);
    const cout = num(c.out, cin + 0.2, info.duration || cin + 0.2, info.duration);
    const crop = {
      top: clampPct(c.crop?.top), bottom: clampPct(c.crop?.bottom), left: clampPct(c.crop?.left), right: clampPct(c.crop?.right),
    };
    if (crop.left + crop.right > 90) crop.right = 90 - crop.left;
    if (crop.top + crop.bottom > 90) crop.bottom = 90 - crop.top;
    clips.push({
      file, info, in: cin, dur: cout - cin, crop,
      mode: c.mode === 'fit' ? 'fit' : 'fill',
      zoom: num(c.zoom, 1, 4, 1), panX: num(c.panX, -0.5, 0.5, 0), panY: num(c.panY, -0.5, 0.5, 0),
      volume: project.muteAll ? 0 : num(c.volume, 0, 1.5, 1),
    });
  }
  const total = clips.reduce((s, c) => s + c.dur, 0);
  if (total > 15 * 60) throw Object.assign(new Error('Keep the video under 15 minutes (Instagram Reels limit).'), { status: 400 });

  // Output size: a preset, or the first clip's cropped shape (720–1920 px wide).
  let [W, H] = FRAMES[project.frame] || [0, 0];
  if (!W) {
    const f = clips[0];
    const cw = f.info.width * (1 - (f.crop.left + f.crop.right) / 100);
    const ch = f.info.height * (1 - (f.crop.top + f.crop.bottom) / 100);
    W = even(Math.max(720, Math.min(1920, cw)));
    H = even((W * ch) / cw);
  }

  const args = ['-y', '-hide_banner'];
  clips.forEach((c) => args.push('-ss', c.in.toFixed(3), '-t', c.dur.toFixed(3), '-i', c.file));
  const m = project.music;
  const hasMusic = m?.path && fs.existsSync(m.path) && num(m.volume, 0, 1.5, 0.8) > 0;
  const mIdx = clips.length;
  if (hasMusic) {
    if (m.loop) args.push('-stream_loop', '-1');
    args.push('-i', m.path);
  }

  const f = [];
  const pairs = [];
  clips.forEach((c, i) => {
    const cw = even(c.info.width * (1 - (c.crop.left + c.crop.right) / 100));
    const chh = even(c.info.height * (1 - (c.crop.top + c.crop.bottom) / 100));
    const cx = Math.round((c.info.width * c.crop.left) / 100);
    const cy = Math.round((c.info.height * c.crop.top) / 100);
    const base = `[${i}:v]crop=${cw}:${chh}:${cx}:${cy},setsar=1`;
    if (c.mode === 'fit') {
      f.push(`${base},split[s${i}a][s${i}b]`);
      f.push(`[s${i}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,eq=brightness=-0.12[bg${i}]`);
      f.push(`[s${i}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg${i}]`);
      f.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1[v${i}]`);
    } else {
      const px = (0.5 + c.panX).toFixed(4);
      const py = (0.5 + c.panY).toFixed(4);
      const zw = Math.ceil((W * c.zoom) / 2) * 2;
      const zh = Math.ceil((H * c.zoom) / 2) * 2;
      f.push(`${base},scale=${zw}:${zh}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${px}:(ih-${H})*${py},fps=30,format=yuv420p,setsar=1[v${i}]`);
    }
    if (c.info.hasAudio && c.volume > 0) {
      f.push(`[${i}:a]volume=${c.volume},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${c.dur.toFixed(3)}[a${i}]`);
    } else {
      f.push(`anullsrc=r=44100:cl=stereo,atrim=0:${c.dur.toFixed(3)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });
  f.push(`${pairs.join('')}concat=n=${clips.length}:v=1:a=1[vout][acat]`);

  if (hasMusic) {
    const vol = num(m.volume, 0, 1.5, 0.8);
    const offset = num(m.offset, 0, Math.max(0, total - 0.5), 0);
    const musicIn = num(m.in, 0, 3600, 0);
    const delay = Math.round(offset * 1000);
    const fadeAt = Math.max(0, total - 1.2).toFixed(3);
    f.push(
      `[${mIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${musicIn.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `atrim=0:${Math.max(0.1, total - offset).toFixed(3)},volume=${vol},afade=t=in:d=0.4,adelay=${delay}|${delay},apad,atrim=0:${total.toFixed(3)},afade=t=out:st=${fadeAt}:d=1.2[mus]`,
    );
    f.push(`[acat][mus]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    f.push(`[acat]anull[aout]`);
  }

  const id = crypto.randomBytes(6).toString('hex');
  const out = path.join(mediaDir, `edit-${id}.mp4`);
  args.push(
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out,
  );

  const job = { id, status: 'running', progress: 0, file: null, error: null, startedAt: Date.now(), width: W, height: H, duration: total };
  jobs.set(id, job);
  const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const killer = setTimeout(() => p.kill('SIGKILL'), 30 * 60 * 1000);
  let err = '';
  p.stdout.on('data', (d) => {
    const mm = String(d).match(/out_time_ms=(\d+)/g);
    if (mm) job.progress = Math.min(99, (Number(mm.at(-1).split('=')[1]) / 1e6 / total) * 100);
  });
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  p.on('close', (code) => {
    clearTimeout(killer);
    if (code === 0 && fs.existsSync(out)) {
      Object.assign(job, { status: 'done', progress: 100, file: path.basename(out), size: fs.statSync(out).size });
    } else {
      job.status = 'error';
      job.error = `Rendering failed: ${err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`;
    }
  });
  return job;
}

/** A strip of frames used as the clip's background on the timeline. */
export async function thumbStrip(ffmpegPath, mediaDir, name, n = 10) {
  const src = path.join(mediaDir, path.basename(name));
  const out = `${src}.strip.jpg`;
  if (fs.existsSync(out)) return out;
  const { duration } = await probe(ffmpegPath, src);
  const rate = Math.max(0.01, n / Math.max(0.5, duration || 1));
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-y', '-hide_banner', '-i', src, '-vf', `fps=${rate.toFixed(4)},scale=-2:72,tile=${n}x1`, '-frames:v', '1', '-q:v', '5', out], { stdio: 'ignore' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Could not make thumbnails'))));
  });
  return out;
}
