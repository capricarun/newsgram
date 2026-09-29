// Canvas renderer for the 1080×1080 card. The same function draws the static
// post and every frame of the reel (pass `anim` = { t, dur } in seconds).

export const SIZE = 1080;

export const ACCENTS = [
  { id: 'lime', c: '#C6FF3D', ink: '#0B0B10', name: 'Electric lime' },
  { id: 'coral', c: '#FF4D6D', ink: '#FFFFFF', name: 'Hot coral' },
  { id: 'saffron', c: '#FFB020', ink: '#0B0B10', name: 'Saffron pop' },
  { id: 'violet', c: '#8B5CF6', ink: '#FFFFFF', name: 'Hyper violet' },
  { id: 'aqua', c: '#22D3EE', ink: '#0B0B10', name: 'Aqua glow' },
  { id: 'white', c: '#F4F4F7', ink: '#0B0B10', name: 'Clean white' },
];

export const TEMPLATES = [
  { id: 'spotlight', name: 'Spotlight' },
  { id: 'split', name: 'Split' },
  { id: 'frame', name: 'Frame' },
  { id: 'bold', name: 'Bold' },
];

const FALLBACK = 'Catamaran, "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Bengali", Poppins, sans-serif';
const HEAD_FONTS = {
  poppins: (s) => `800 ${s}px Poppins, ${FALLBACK}`,
  anton: (s) => `400 ${s}px Anton, ${FALLBACK}`,
  playfair: (s) => `800 ${s}px "Playfair Display", ${FALLBACK}`,
  grotesk: (s) => `700 ${s}px "Space Grotesk", ${FALLBACK}`,
  catamaran: (s) => `900 ${s}px Catamaran, ${FALLBACK}`,
};
const bodyFont = (s, w = 500) => `${w} ${s}px Inter, Poppins, ${FALLBACK}`;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (v) => 1 - Math.pow(1 - clamp01(v), 3);

function setSpacing(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

/* ---------- text layout ---------- */
function tokens(text, upper) {
  const out = [];
  let hl = false;
  for (const part of String(text || '').split('*')) {
    for (const w of part.split(/\s+/).filter(Boolean)) out.push({ t: upper ? w.toUpperCase() : w, hl });
    hl = !hl;
  }
  return out;
}

function wrap(ctx, words, maxW) {
  const space = ctx.measureText(' ').width;
  const lines = [];
  let line = [];
  let w = 0;
  for (const word of words) {
    const ww = ctx.measureText(word.t).width;
    if (line.length && w + space + ww > maxW) {
      lines.push({ words: line, w });
      line = [];
      w = 0;
    }
    word.w = ww;
    word.x = line.length ? w + space : 0;
    w = line.length ? w + space + ww : ww;
    line.push(word);
  }
  if (line.length) lines.push({ words: line, w });
  return lines;
}

function fitHeadline(ctx, c, maxW, maxLines, maxH) {
  const upper = c.font === 'anton';
  let size = c.headSize * (upper ? 1.08 : 1);
  const lh = c.font === 'anton' ? 1.05 : c.font === 'playfair' ? 1.12 : 1.1;
  for (;;) {
    ctx.font = HEAD_FONTS[c.font || 'poppins'](size);
    const lines = wrap(ctx, tokens(c.headline, upper), maxW);
    const h = lines.length * size * lh;
    if ((lines.length <= maxLines && h <= maxH) || size <= 36) return { lines, size, lineH: size * lh, h };
    size -= 2;
  }
}

function layoutBody(ctx, c, maxW, maxLines) {
  if (!c.showBody || !c.body?.trim()) return { lines: [], h: 0, size: 0, lineH: 0 };
  const size = c.bodySize;
  ctx.font = bodyFont(size);
  let lines = wrap(ctx, tokens(c.body.replace(/\*/g, ''), false), maxW);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1].words;
    last[last.length - 1].t = last[last.length - 1].t.replace(/[.,;:]?$/, '…');
  }
  const lineH = size * 1.38;
  return { lines, size, lineH, h: lines.length * lineH };
}

/** Draws headline lines. `style` = 'color' (highlight = accent text) or 'block' (accent box behind words). */
function drawHeadline(ctx, c, L, x, y, align, maxW, reveal, style = 'color') {
  const accent = c.accentColor;
  ctx.font = HEAD_FONTS[c.font || 'poppins'](L.size);
  ctx.textBaseline = 'alphabetic';
  let i = 0;
  L.lines.forEach((line, li) => {
    const lx = align === 'center' ? x + (maxW - line.w) / 2 : x;
    const baseY = y + L.lineH * (li + 1) - L.lineH * 0.22;
    const pOf = (idx) => (reveal == null ? 1 : easeOut((reveal - idx * 0.07) / 0.35));
    if (style === 'block') {
      // One accent box per run of consecutive highlighted words.
      let run = null;
      const flush = () => {
        if (!run) return;
        const p = pOf(run.i);
        if (p > 0) {
          const padX = L.size * 0.14;
          ctx.save();
          ctx.globalAlpha = p;
          ctx.fillStyle = accent;
          roundRect(ctx, lx + run.x0 - padX, baseY - L.size * 0.86 + (1 - p) * 30, run.x1 - run.x0 + padX * 2, L.size * 1.04, 10);
          ctx.fill();
          ctx.restore();
        }
        run = null;
      };
      line.words.forEach((w, wi) => {
        if (w.hl) {
          if (!run) run = { x0: w.x, i: i + wi };
          run.x1 = w.x + w.w;
        } else flush();
      });
      flush();
    }
    for (const w of line.words) {
      const p = pOf(i);
      i++;
      if (p <= 0) continue;
      ctx.save();
      ctx.globalAlpha = p;
      const dy = (1 - p) * 30;
      if (w.hl && style === 'block') {
        ctx.fillStyle = c.accentInk;
      } else {
        ctx.fillStyle = w.hl ? accent : '#FFFFFF';
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = 18;
      }
      ctx.fillText(w.t, lx + w.x, baseY + dy);
      ctx.restore();
    }
  });
}

function drawBody(ctx, B, x, y, align, maxW, alpha = 1, color = 'rgba(255,255,255,0.86)') {
  if (!B.lines.length || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = bodyFont(B.size);
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  B.lines.forEach((line, li) => {
    const text = line.words.map((w) => w.t).join(' ');
    const lx = align === 'center' ? x + (maxW - ctx.measureText(text).width) / 2 : x;
    ctx.fillText(text, lx, y + B.lineH * (li + 1) - B.lineH * 0.28 + (1 - alpha) * 16);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function pill(ctx, text, x, y, { bg, fg, size = 24, align = 'left', border } = {}) {
  ctx.save();
  ctx.font = bodyFont(size, 700);
  setSpacing(ctx, size * 0.08);
  const w = ctx.measureText(text).width + size * 1.3;
  const h = size * 1.75;
  const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  roundRect(ctx, px, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + size * 0.65, y + h / 2 + 1);
  ctx.restore();
  return w;
}

/* ---------- image ---------- */
function drawImage(ctx, c, area, zoom = 1, radius = 0) {
  ctx.save();
  if (radius) {
    roundRect(ctx, area.x, area.y, area.w, area.h, radius);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
  }
  const img = c.img;
  if (!img) {
    const g = ctx.createLinearGradient(area.x, area.y, area.x + area.w, area.y + area.h);
    g.addColorStop(0, '#1b1b2a');
    g.addColorStop(1, c.sourceColor || '#333');
    ctx.fillStyle = g;
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.restore();
    return;
  }
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const cover = Math.max(area.w / iw, area.h / ih);
  const s = cover * c.imgScale * zoom;
  const dw = iw * s;
  const dh = ih * s;
  const cx = area.x + area.w / 2 + c.imgX;
  const cy = area.y + area.h / 2 + c.imgY;
  if (dw < area.w - 1 || dh < area.h - 1) {
    // Letterboxed: fill the gap with a blurred, darkened copy.
    ctx.save();
    ctx.filter = 'blur(36px) brightness(0.55) saturate(1.2)';
    const bs = cover * 1.15;
    ctx.drawImage(img, area.x + area.w / 2 - (iw * bs) / 2, area.y + area.h / 2 - (ih * bs) / 2, iw * bs, ih * bs);
    ctx.restore();
  }
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();
}

/** Keeps the image covering its frame while panning (or centred inside it when zoomed out). */
export function clampPan(c) {
  if (!c.img) return;
  const A = imageArea(c.template);
  const iw = c.img.naturalWidth || c.img.width;
  const ih = c.img.naturalHeight || c.img.height;
  const s = Math.max(A.w / iw, A.h / ih) * c.imgScale;
  const limX = Math.abs(iw * s - A.w) / 2;
  const limY = Math.abs(ih * s - A.h) / 2;
  c.imgX = Math.max(-limX, Math.min(limX, c.imgX));
  c.imgY = Math.max(-limY, Math.min(limY, c.imgY));
}

export function imageArea(template) {
  switch (template) {
    case 'split': return { x: 0, y: 0, w: SIZE, h: 600 };
    case 'frame': return { x: 60, y: 150, w: 960, h: 500 };
    default: return { x: 0, y: 0, w: SIZE, h: SIZE };
  }
}

/* ---------- shared chrome ---------- */
function chips(ctx, c, y, align, p, reveal) {
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha = p;
  const dx = (1 - p) * -20;
  let x = align === 'center' ? SIZE / 2 : 72;
  if (c.showSource && c.sourceName) {
    const label = c.sourceName.toUpperCase();
    if (align === 'center') {
      pill(ctx, label, x + dx, y, { bg: c.accentColor, fg: c.accentInk, align: 'center' });
    } else {
      const w = pill(ctx, label, x + dx, y, { bg: c.accentColor, fg: c.accentInk });
      if (c.categoryLabel) pill(ctx, c.categoryLabel.toUpperCase(), x + w + 12 + dx, y, { bg: 'rgba(0,0,0,0.45)', fg: '#fff', border: 'rgba(255,255,255,0.25)' });
    }
  }
  if (c.breaking) {
    const pulse = reveal == null ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(reveal * 4));
    ctx.globalAlpha = p * pulse;
    pill(ctx, '● BREAKING', SIZE - 72, align === 'center' ? y + 60 : y, { bg: '#FF2D55', fg: '#fff', align: 'right' });
  }
  ctx.restore();
}

function footer(ctx, c, y, color = 'rgba(255,255,255,0.72)') {
  ctx.save();
  ctx.font = bodyFont(24, 600);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  setSpacing(ctx, 1);
  if (c.handle) ctx.fillText(c.handle, 72, y);
  const right = [c.showSource && c.sourceName ? `Source: ${c.sourceName}` : '', c.dateLabel].filter(Boolean).join('  ·  ');
  ctx.textAlign = 'right';
  ctx.fillText(right, SIZE - 72, y);
  ctx.restore();
}

function progressBar(ctx, c, anim) {
  if (!anim) return;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(0, SIZE - 8, SIZE, 8);
  ctx.fillStyle = c.accentColor;
  ctx.fillRect(0, SIZE - 8, SIZE * clamp01(anim.t / anim.dur), 8);
}

/* ---------- main ---------- */
export function renderCard(ctx, c, anim = null) {
  const t = anim ? anim.t : null;
  const zoom = anim ? 1 + 0.1 * easeOut(anim.t / anim.dur) : 1;
  const chipP = anim ? easeOut(t / 0.45) : 1;
  const headReveal = anim ? Math.max(0, t - 0.35) : null;
  const wordCount = tokens(c.headline).length;
  const bodyStart = 0.35 + wordCount * 0.07 + 0.3;
  const bodyA = anim ? easeOut((t - bodyStart) / 0.5) : 1;
  const dim = c.dim / 100;

  ctx.save();
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#0B0B10';
  ctx.fillRect(0, 0, SIZE, SIZE);

  const P = 72;
  const maxW = SIZE - P * 2;

  if (c.template === 'split') {
    drawImage(ctx, c, imageArea('split'), zoom);
    const top = ctx.createLinearGradient(0, 0, 0, 200);
    top.addColorStop(0, `rgba(0,0,0,${0.5 * dim})`);
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, SIZE, 200);
    const panel = ctx.createLinearGradient(0, 600, 0, SIZE);
    panel.addColorStop(0, '#101018');
    panel.addColorStop(1, '#07070B');
    ctx.fillStyle = panel;
    ctx.fillRect(0, 600, SIZE, SIZE - 600);
    const glow = ctx.createRadialGradient(SIZE, SIZE, 0, SIZE, SIZE, 520);
    glow.addColorStop(0, hexA(c.accentColor, 0.16));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 600, SIZE, SIZE - 600);
    const bar = ctx.createLinearGradient(0, 0, SIZE, 0);
    bar.addColorStop(0, c.accentColor);
    bar.addColorStop(1, hexA(c.accentColor, 0.2));
    ctx.fillStyle = bar;
    ctx.fillRect(0, 596, SIZE * (anim ? easeOut(t / 0.6) : 1), 8);
    chips(ctx, c, 60, 'left', chipP, t);

    const B0 = layoutBody(ctx, c, maxW, 3);
    const budget = SIZE - 650 - 110 - (B0.h ? B0.h + 24 : 0);
    const H = fitHeadline(ctx, c, maxW, 3, budget);
    drawHeadline(ctx, c, H, P, 648, 'left', maxW, headReveal);
    drawBody(ctx, B0, P, 648 + H.h + 20, 'left', maxW, bodyA, 'rgba(255,255,255,0.78)');
    footer(ctx, c, SIZE - 56, 'rgba(255,255,255,0.6)');
  } else if (c.template === 'frame') {
    const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    bg.addColorStop(0, '#12121C');
    bg.addColorStop(1, '#07070B');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const glow = ctx.createRadialGradient(SIZE * 0.85, 120, 0, SIZE * 0.85, 120, 700);
    glow.addColorStop(0, hexA(c.accentColor, 0.28));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, SIZE, SIZE);
    chips(ctx, c, 60, 'left', chipP, t);
    const A = imageArea('frame');
    drawImage(ctx, c, A, zoom, 28);
    ctx.save();
    roundRect(ctx, A.x, A.y, A.w, A.h, 28);
    ctx.strokeStyle = hexA(c.accentColor, 0.55);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    const B0 = layoutBody(ctx, c, maxW, 2);
    const budget = SIZE - 690 - 100 - (B0.h ? B0.h + 18 : 0);
    const H = fitHeadline(ctx, c, maxW, 3, budget);
    drawHeadline(ctx, c, H, P, 684, 'left', maxW, headReveal);
    drawBody(ctx, B0, P, 684 + H.h + 14, 'left', maxW, bodyA, 'rgba(255,255,255,0.75)');
    footer(ctx, c, SIZE - 52, 'rgba(255,255,255,0.55)');
  } else if (c.template === 'bold') {
    drawImage(ctx, c, imageArea('bold'), zoom);
    ctx.fillStyle = `rgba(0,0,0,${0.25 + 0.5 * dim})`;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const v = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 200, SIZE / 2, SIZE / 2, 800);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, SIZE, SIZE);
    chips(ctx, c, 72, 'center', chipP, t);

    const B0 = layoutBody(ctx, c, maxW - 60, 3);
    const H = fitHeadline(ctx, { ...c, headSize: c.headSize * 1.2 }, maxW, 5, 560);
    const total = H.h + (B0.h ? B0.h + 36 : 0);
    const y0 = (SIZE - total) / 2 + 20;
    drawHeadline(ctx, c, H, P, y0, 'center', maxW, headReveal, 'block');
    drawBody(ctx, B0, P + 30, y0 + H.h + 36, 'center', maxW - 60, bodyA);
    footer(ctx, c, SIZE - 60);
  } else {
    // spotlight
    drawImage(ctx, c, imageArea('spotlight'), zoom);
    const B0 = layoutBody(ctx, c, maxW, 4);
    const footerY = SIZE - 60;
    const bodyTop = footerY - 44 - B0.h;
    const H = fitHeadline(ctx, c, maxW, 4, 420);
    const headTop = bodyTop - (B0.h ? 26 : 0) - H.h;

    const top = ctx.createLinearGradient(0, 0, 0, 260);
    top.addColorStop(0, `rgba(0,0,0,${0.55 * dim})`);
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, SIZE, 260);
    const gStart = Math.max(0, headTop - 260);
    const g = ctx.createLinearGradient(0, gStart, 0, SIZE);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.35, `rgba(0,0,0,${0.45 * dim + 0.1})`);
    g.addColorStop(1, `rgba(0,0,0,${0.55 + 0.4 * dim})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, gStart, SIZE, SIZE - gStart);

    chips(ctx, c, 64, 'left', chipP, t);
    ctx.fillStyle = c.accentColor;
    ctx.fillRect(P, headTop - 34, 96 * (anim ? easeOut((t - 0.2) / 0.5) : 1), 10);
    drawHeadline(ctx, c, H, P, headTop, 'left', maxW, headReveal);
    drawBody(ctx, B0, P, bodyTop, 'left', maxW, bodyA);
    footer(ctx, c, footerY);
  }

  progressBar(ctx, c, anim);
  ctx.restore();
}

export function reelEndTime(c) {
  return 0.35 + tokens(c.headline).length * 0.07 + 0.3 + 0.5;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
