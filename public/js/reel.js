// Records the animated card into a video using the browser's MediaRecorder,
// optionally mixing in a music track (Web Audio → MediaStream audio track).

const VIDEO_ONLY = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];
const WITH_AUDIO = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime(withAudio = false) {
  if (typeof MediaRecorder === 'undefined') return '';
  return (withAudio ? WITH_AUDIO : VIDEO_ONLY).find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

let sharedCtx = null;
export function audioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AC();
  return sharedCtx;
}

/**
 * Schedules `music.buffer` into `destination` with fade in/out.
 * Returns the source node so the caller can stop it.
 */
export function playMusic(ctx, destination, music, dur) {
  const src = ctx.createBufferSource();
  src.buffer = music.buffer;
  src.loop = music.buffer.duration - (music.offset || 0) < dur; // short uploads loop
  const gain = ctx.createGain();
  const vol = music.volume ?? 0.8;
  const t0 = ctx.currentTime + 0.02;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.35);
  gain.gain.setValueAtTime(vol, t0 + Math.max(0.4, dur - 1.2));
  gain.gain.linearRampToValueAtTime(0, t0 + dur);
  src.connect(gain).connect(destination);
  src.start(t0, Math.min(music.offset || 0, Math.max(0, music.buffer.duration - 0.5)));
  src.stop(t0 + dur + 0.1);
  return src;
}

export function recordReel(canvas, drawFrame, dur, onProgress = () => {}, music = null) {
  return new Promise(async (resolve, reject) => {
    const withAudio = Boolean(music?.buffer);
    const mime = pickMime(withAudio);
    if (!mime || !canvas.captureStream) return reject(new Error('This browser cannot record video — try Chrome, Edge or Safari.'));

    const canvasStream = canvas.captureStream(30);
    const tracks = [...canvasStream.getVideoTracks()];
    let ctx = null;
    let dest = null;
    if (withAudio) {
      ctx = audioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      dest = ctx.createMediaStreamDestination();
      tracks.push(...dest.stream.getAudioTracks());
    }
    const stream = new MediaStream(tracks);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      canvasStream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      blob.hasAudio = withAudio;
      resolve(blob);
    };

    drawFrame({ t: 0, dur });
    rec.start(250);
    if (withAudio) playMusic(ctx, dest, music, dur);
    const t0 = performance.now();
    const tick = (now) => {
      const t = (now - t0) / 1000;
      drawFrame({ t: Math.min(t, dur), dur });
      onProgress(Math.min(1, t / dur));
      if (t < dur) requestAnimationFrame(tick);
      else setTimeout(() => rec.state !== 'inactive' && rec.stop(), 150);
    };
    requestAnimationFrame(tick);
  });
}
