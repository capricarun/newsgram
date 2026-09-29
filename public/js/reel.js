// Records the animated card into a video using the browser's MediaRecorder.

const CANDIDATES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export function recordReel(canvas, drawFrame, dur, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const mime = pickMime();
    if (!mime || !canvas.captureStream) return reject(new Error('This browser cannot record video — try Chrome, Edge or Safari.'));
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: mime.split(';')[0] }));
    };

    drawFrame({ t: 0, dur });
    rec.start(250);
    const t0 = performance.now();
    const tick = (now) => {
      const t = (now - t0) / 1000;
      drawFrame({ t: Math.min(t, dur), dur });
      onProgress(Math.min(1, t / dur));
      if (t < dur) requestAnimationFrame(tick);
      else setTimeout(() => rec.state !== 'inactive' && rec.stop(), 120);
    };
    requestAnimationFrame(tick);
  });
}
