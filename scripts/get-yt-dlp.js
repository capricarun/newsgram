// Downloads the standalone yt-dlp binary (no Python needed) into ./bin.
// Runs on `npm install`; re-run any time with `npm run update-ytdlp`
// (sites like YouTube change often and yt-dlp ships fixes quickly).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin');
const target = path.join(bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const asset =
  process.platform === 'darwin' ? 'yt-dlp_macos'
  : process.platform === 'win32' ? 'yt-dlp.exe'
  : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64'
  : 'yt-dlp_linux';

const force = process.argv.includes('--force');
if (fs.existsSync(target) && !force) {
  console.log('yt-dlp already present:', path.relative(root, target));
  process.exit(0);
}

try {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log('Downloading', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(bin, { recursive: true });
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, target);
  console.log(`yt-dlp saved to ${path.relative(root, target)} (${(buf.length / 1e6).toFixed(1)} MB)`);
} catch (e) {
  // Never fail the whole install — the grabber just reports that yt-dlp is missing.
  console.warn(`Could not download yt-dlp (${e.message}). Video grabbing will be disabled until you run: npm run update-ytdlp`);
}
