// Encodes decoded PCM to MP3 off the main thread (lamejs, vendored in /vendor).
/* global lamejs */
importScripts('/vendor/lame.min.js');

const to16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

onmessage = (e) => {
  try {
    const { left, right, sampleRate, kbps } = e.data;
    const L = to16(left);
    const R = right ? to16(right) : null;
    const enc = new lamejs.Mp3Encoder(R ? 2 : 1, sampleRate, kbps);
    const BLOCK = 1152;
    const parts = [];
    let lastReport = 0;
    for (let i = 0; i < L.length; i += BLOCK) {
      const mp3 = R ? enc.encodeBuffer(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK)) : enc.encodeBuffer(L.subarray(i, i + BLOCK));
      if (mp3.length) parts.push(new Uint8Array(mp3));
      if (i - lastReport > sampleRate * 5) {
        lastReport = i;
        postMessage({ progress: i / L.length });
      }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    postMessage({ done: new Blob(parts, { type: 'audio/mpeg' }) });
  } catch (err) {
    postMessage({ error: err.message || String(err) });
  }
};
