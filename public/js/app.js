import { renderCard, SIZE, ACCENTS, TEMPLATES, imageArea, clampPan } from './render.js';
import { recordReel, pickMime } from './reel.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

/* ---------------- persistence (per-browser conveniences) ---------------- */
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`ng:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`ng:${k}`, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  config: null,
  sources: new Set(store.get('sources', ['thehindu', 'indianexpress', 'toi', 'ndtv'])),
  category: store.get('category', 'top'),
  includeX: store.get('includeX', false),
  tone: store.get('tone', 'punchy'),
  lang: store.get('lang', 'en'),
  news: null,
  rewrites: new Map(),
  aiLive: false,
  tab: 'rss',
  item: null,
  article: null,
  busy: false,
};

const card = {
  headline: '',
  body: '',
  caption: '',
  img: null,
  imgSrc: '',
  imgX: 0,
  imgY: 0,
  imgScale: 1,
  dim: 70,
  template: store.get('template', 'spotlight'),
  accent: store.get('accent', 'lime'),
  font: store.get('font', 'poppins'),
  headSize: 76,
  bodySize: 34,
  showBody: true,
  showSource: true,
  breaking: false,
  handle: store.get('handle', ''),
  sourceName: '',
  sourceColor: '',
  categoryLabel: '',
  dateLabel: '',
  get accentColor() {
    return (ACCENTS.find((a) => a.id === this.accent) || ACCENTS[0]).c;
  },
  get accentInk() {
    return (ACCENTS.find((a) => a.id === this.accent) || ACCENTS[0]).ink;
  },
};

/* ---------------- helpers ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json', ...(opts.headers || {}) } : opts.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, { error = false, html = false, ms = 3500 } = {}) {
  const el = $('#toast');
  el[html ? 'innerHTML' : 'textContent'] = msg;
  el.classList.toggle('err', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function busy(btn, on) {
  btn.classList.toggle('is-loading', on);
  btn.disabled = on;
}

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const proxied = (url) => (!url ? '' : /^https?:/i.test(url) ? `/api/img?url=${encodeURIComponent(url)}` : url);

function slug(s) {
  return (s || 'news').toLowerCase().replace(/\*/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'news';
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- steps ---------------- */
function go(step) {
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${step}`));
  $$('.step').forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle('is-active', n === step);
    b.classList.toggle('is-done', n < step);
  });
  if (step >= 2) $('.step[data-step="2"]').disabled = false;
  if (step === 3) $('.step[data-step="3"]').disabled = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.step').forEach((b) => b.addEventListener('click', () => !b.disabled && go(Number(b.dataset.step))));

/* ---------------- step 1: sources ---------------- */
function renderSources() {
  const { sources, categories, features } = state.config;
  $('#sourceGrid').innerHTML = sources
    .map(
      (s) => `<button class="source-card" style="--c:${s.color}" data-id="${s.id}" aria-pressed="${state.sources.has(s.id)}">
        <span class="s-name"><span class="s-dot"></span>${esc(s.name)}</span>
        <span class="s-meta">${esc(s.domain)} · @${esc(s.x)}</span>
        <span class="s-check">✓</span>
      </button>`,
    )
    .join('');
  $$('#sourceGrid .source-card').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      state.sources.has(id) ? state.sources.delete(id) : state.sources.add(id);
      b.setAttribute('aria-pressed', state.sources.has(id));
      updatePick();
    }),
  );

  $('#catChips').innerHTML = categories
    .map((c) => `<button class="chip" role="radio" data-id="${c.id}" aria-checked="${c.id === state.category}">${esc(c.label)}</button>`)
    .join('');
  $$('#catChips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.category = b.dataset.id;
      $$('#catChips .chip').forEach((x) => x.setAttribute('aria-checked', x === b));
      updatePick();
    }),
  );

  const x = $('#includeX');
  x.checked = state.includeX && features.x;
  x.disabled = !features.x;
  $('#xSwitch').classList.toggle('is-disabled', !features.x);
  $('#xNote').textContent = features.x ? '' : '— needs an X API token on the server';
  $('#xNote').className = 'muted';
  x.addEventListener('change', () => (state.includeX = x.checked));

  $('#tone').value = state.tone;
  $('#lang').value = state.lang;
  $('#tone').addEventListener('change', (e) => (state.tone = e.target.value));
  $('#lang').addEventListener('change', (e) => (state.lang = e.target.value));
  updatePick();
}

function updatePick() {
  const n = state.sources.size;
  const cat = state.config.categories.find((c) => c.id === state.category)?.label;
  $('#pickSummary').textContent = n ? `${n} source${n > 1 ? 's' : ''} · ${cat}` : 'Pick at least one source';
  $('#fetchBtn').disabled = !n;
}

$('#selAll').addEventListener('click', () => {
  state.config.sources.forEach((s) => state.sources.add(s.id));
  $$('#sourceGrid .source-card').forEach((b) => b.setAttribute('aria-pressed', 'true'));
  updatePick();
});
$('#selNone').addEventListener('click', () => {
  state.sources.clear();
  $$('#sourceGrid .source-card').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  updatePick();
});

$('#fetchBtn').addEventListener('click', () => loadNews());
$('#refreshBtn').addEventListener('click', () => loadNews());
$('#backTo1').addEventListener('click', () => go(1));
$('#backTo2').addEventListener('click', () => go(2));

/* ---------------- step 2: stories ---------------- */
async function loadNews() {
  store.set('sources', [...state.sources]);
  store.set('category', state.category);
  store.set('includeX', state.includeX);
  store.set('tone', state.tone);
  store.set('lang', state.lang);
  go(2);
  const cat = state.config.categories.find((c) => c.id === state.category)?.label;
  $('#storiesEyebrow').textContent = `${cat} · ${state.sources.size} source${state.sources.size > 1 ? 's' : ''}`;
  $('#statusRow').innerHTML = '';
  $('#storyTabs').hidden = true;
  $('#storyGrid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton shimmer"></div>').join('');
  busy($('#fetchBtn'), true);
  try {
    const q = new URLSearchParams({ sources: [...state.sources].join(','), category: state.category, x: state.includeX ? '1' : '0' });
    state.news = await api(`/api/news?${q}`);
    state.rewrites.clear();
    renderStatus();
    state.tab = 'rss';
    $('#storyTabs').hidden = !state.news.xItems?.length;
    $$('#storyTabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'rss'));
    renderStories();
    rewriteVisible();
  } catch (e) {
    $('#storyGrid').innerHTML = `<div class="empty">Couldn't load news: ${esc(e.message)}</div>`;
  } finally {
    busy($('#fetchBtn'), false);
  }
}

function renderStatus() {
  $('#statusRow').innerHTML = state.news.status
    .map((s) => {
      const src = state.config.sources.find((x) => x.id === s.id);
      const cls = !s.count ? 'err' : /news\.google/.test(s.feed || '') ? 'gn' : '';
      const tip = !s.count ? s.errors.join('\n') : /news\.google/.test(s.feed || '') ? 'Publisher feed failed — using Google News (no images; add one in the studio)' : s.feed;
      return `<span class="status-pill ${cls}" style="--c:${src?.color}" title="${esc(tip)}"><span class="d"></span>${esc(s.name)} · ${s.count || 'failed'}</span>`;
    })
    .join('');
}

$$('#storyTabs .tab').forEach((t) =>
  t.addEventListener('click', () => {
    state.tab = t.dataset.tab;
    $$('#storyTabs .tab').forEach((x) => x.classList.toggle('is-active', x === t));
    renderStories();
    rewriteVisible();
  }),
);

function currentList() {
  return state.tab === 'x' ? state.news?.xItems || [] : state.news?.items || [];
}

function renderStories() {
  const list = currentList();
  if (!list.length) {
    $('#storyGrid').innerHTML = `<div class="empty">No stories came back for this selection. Try another category or source — hover the red pills above to see why.</div>`;
    return;
  }
  $('#storyGrid').innerHTML = list
    .map((it) => {
      const rw = state.rewrites.get(it.id);
      return `<button class="story" data-id="${it.id}">
        <div class="story-media">
          ${it.image ? `<img src="${esc(proxied(it.image))}" alt="" loading="lazy" onerror="this.remove()">` : '<span class="noimg">No image — add one in the studio</span>'}
          <div class="story-badges">
            <span class="badge" style="--c:${it.sourceColor}"><span class="d"></span>${esc(it.sourceName)}</span>
            ${it.video ? '<span class="badge video">▶ Video</span>' : ''}
          </div>
          <div class="story-head ${rw ? '' : 'shimmer'}" data-head>${esc(rw?.headline || it.title)}</div>
        </div>
        <div class="story-body">
          <p data-body>${esc(rw?.body || it.summary || '')}</p>
          <div class="story-foot"><span>${timeAgo(it.published)}${rw && !state.aiLive ? ' · basic rewrite' : rw ? ' · ✦ AI' : ''}</span><span class="go">Design →</span></div>
        </div>
      </button>`;
    })
    .join('');
  $$('#storyGrid .story').forEach((b) => b.addEventListener('click', () => openStudio(list.find((i) => i.id === b.dataset.id))));
}

/** One AI call per batch of 12 stories rewrites the grid headlines. */
async function rewriteVisible() {
  const list = currentList().filter((i) => !state.rewrites.has(i.id)).slice(0, 36);
  const batches = [];
  for (let i = 0; i < list.length; i += 12) batches.push(list.slice(i, i + 12));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const out = await api('/api/ai/headlines', {
          method: 'POST',
          body: JSON.stringify({ items: batch.map(({ id, title, summary }) => ({ id, title, summary })), tone: state.tone, lang: state.lang }),
        });
        state.aiLive = out.ai;
        out.items.forEach((r) => r?.id && state.rewrites.set(r.id, r));
      } catch (e) {
        console.warn(e);
        toast(`AI rewrite failed: ${e.message}`, { error: true });
      }
      for (const it of batch) {
        const el = $(`.story[data-id="${it.id}"]`);
        if (!el) continue;
        const rw = state.rewrites.get(it.id);
        const h = $('[data-head]', el);
        h.classList.remove('shimmer');
        if (rw) {
          h.textContent = rw.headline.replace(/\*/g, '');
          $('[data-body]', el).textContent = rw.body;
          $('.story-foot span', el).textContent = `${timeAgo(it.published)} · ${state.aiLive ? '✦ AI' : 'basic rewrite'}`;
        }
      }
    }),
  );
}

/* ---------------- step 3: studio ---------------- */
const canvas = $('#card');
const ctx = canvas.getContext('2d');
let raf = 0;
function draw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    clampPan(card);
    renderCard(ctx, card);
  });
}

function defaultCaption() {
  const tags = ['#news', '#india', '#newsupdate', `#${(state.item?.category || 'latest').replace(/\W/g, '')}`, `#${(card.sourceName || '').replace(/\W/g, '').toLowerCase()}`];
  return `${card.headline.replace(/\*/g, '')}\n\n${card.body}\n\nSource: ${card.sourceName}\n\n${tags.join(' ')}${card.handle ? `\n\nFollow ${card.handle} for more` : ''}`;
}

async function loadImage(src) {
  if (!src) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function setImage(src, { keepTransform = false } = {}) {
  card.imgSrc = src;
  const img = await loadImage(proxied(src));
  if (card.imgSrc !== src) return; // a newer choice won
  if (!img && src) toast("Couldn't load that image — try another or upload one.", { error: true });
  card.img = img;
  if (!keepTransform) resetTransform();
  $$('#thumbs button').forEach((b) => b.classList.toggle('is-active', b.dataset.src === src));
  draw();
  renderStylePickers();
}

function resetTransform() {
  card.imgX = 0;
  card.imgY = 0;
  card.imgScale = 1;
  syncZoom();
}
function syncZoom() {
  $('#zoom').value = Math.round(card.imgScale * 100);
  $('#zoomOut').textContent = `${Math.round(card.imgScale * 100)}%`;
}

async function openStudio(item) {
  state.item = item;
  state.article = null;
  const rw = state.rewrites.get(item.id);
  const cat = state.config.categories.find((c) => c.id === state.category);
  Object.assign(card, {
    headline: rw?.headline || item.title,
    body: rw?.body || item.summary?.slice(0, 260) || '',
    sourceName: item.kind === 'x' ? state.config.sources.find((s) => s.id === item.sourceId)?.name : item.sourceName,
    sourceColor: item.sourceColor,
    categoryLabel: cat?.id === 'top' ? '' : cat?.label || '',
    dateLabel: new Date(item.published).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    breaking: false,
    img: null,
  });
  captionTouched = false;
  card.caption = defaultCaption();
  syncFields();
  $('#origTitle').textContent = item.title;
  $('#origText').textContent = item.summary || '';
  $('#sourceLine').innerHTML = `Original: <a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.sourceName)} ↗</a>${item.postUrl ? ` · <a href="${esc(item.postUrl)}" target="_blank" rel="noopener">X post ↗</a>` : ''}`;
  $('#thumbs').innerHTML = '<p class="muted small">Loading…</p>';
  $('#srcVideos').innerHTML = '<p class="muted small">Checking the article…</p>';
  $('#aiNote').textContent = state.config.features.ai ? 'Rewrites from the full original article.' : 'AI key not set — uses a basic rewrite.';
  go(3);
  await document.fonts.ready;
  setImage(item.image || '');

  if (item.link && !/^https:\/\/x\.com/.test(item.link)) {
    try {
      state.article = await api(`/api/article?url=${encodeURIComponent(item.link)}`);
    } catch (e) {
      state.article = { images: [], videos: [], error: e.message };
    }
  } else state.article = { images: [], videos: [] };
  if (state.item !== item) return;
  if (!item.image && state.article.image) setImage(state.article.image);
  renderThumbs();
  renderVideos();
}

function renderThumbs() {
  const imgs = [...new Set([state.item.image, ...(state.article?.images || [])].filter(Boolean))];
  $('#thumbs').innerHTML = imgs.length
    ? imgs.map((src) => `<button data-src="${esc(src)}" class="${src === card.imgSrc ? 'is-active' : ''}"><img src="${esc(proxied(src))}" alt="" onerror="this.parentElement.remove()"></button>`).join('')
    : '<p class="muted small">No other images found in the article.</p>';
  $$('#thumbs button').forEach((b) => b.addEventListener('click', () => setImage(b.dataset.src)));
}

function renderVideos() {
  const vids = [];
  if (state.item.video) vids.push({ url: state.item.video, type: /\.m3u8/.test(state.item.video) ? 'stream' : 'file' });
  for (const v of state.article?.videos || []) if (!vids.some((x) => x.url === v.url)) vids.push(v);
  const name = slug(card.headline);
  $('#srcVideos').innerHTML = vids.length
    ? vids
        .map((v) => {
          const short = v.url.replace(/^https?:\/\//, '').slice(0, 48);
          return v.type === 'file'
            ? `<div class="vid-item"><span title="${esc(v.url)}">${esc(short)}</span><a class="btn btn-ghost btn-s" href="/api/video?url=${encodeURIComponent(v.url)}&name=${encodeURIComponent(name)}" download>⬇ Download</a></div>`
            : `<div class="vid-item"><span title="${esc(v.url)}">${v.type === 'stream' ? 'Streaming video' : 'Embedded player'} — can't be saved directly</span><a class="btn btn-ghost btn-s" href="${esc(v.url)}" target="_blank" rel="noopener">Open ↗</a></div>`;
        })
        .join('') + '<p class="muted small">Check you have rights to reuse a publisher\'s video before posting it.</p>'
    : '<p class="muted small">This story has no downloadable video.</p>';
}

function syncFields() {
  $('#headline').value = card.headline;
  $('#body').value = card.body;
  $('#caption').value = card.caption;
  $('#dim').value = card.dim;
  $('#dimOut').textContent = `${card.dim}%`;
  $('#font').value = card.font;
  $('#headSize').value = card.headSize;
  $('#hsOut').textContent = card.headSize;
  $('#bodySize').value = card.bodySize;
  $('#bsOut').textContent = card.bodySize;
  $('#showBody').checked = card.showBody;
  $('#showSource').checked = card.showSource;
  $('#breaking').checked = card.breaking;
  $('#handle').value = card.handle;
  syncZoom();
  renderStylePickers();
}

/* inspector tabs */
$$('.inspector .tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.inspector .tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $$('.ipanel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === t.dataset.panel));
  }),
);

/* copy */
let captionTouched = false;
$('#headline').addEventListener('input', (e) => {
  card.headline = e.target.value;
  if (!captionTouched) $('#caption').value = card.caption = defaultCaption();
  draw();
});
$('#body').addEventListener('input', (e) => {
  card.body = e.target.value;
  if (!captionTouched) $('#caption').value = card.caption = defaultCaption();
  draw();
});
$('#caption').addEventListener('input', (e) => {
  card.caption = e.target.value;
  captionTouched = true;
});
$('#useOriginal').addEventListener('click', () => {
  card.headline = state.item.title;
  $('#headline').value = card.headline;
  draw();
});

$('#aiBtn').addEventListener('click', async () => {
  const btn = $('#aiBtn');
  busy(btn, true);
  try {
    const it = state.item;
    const out = await api('/api/ai/rephrase', {
      method: 'POST',
      body: JSON.stringify({
        url: it.kind === 'x' ? '' : it.link,
        title: it.title,
        summary: it.summary,
        sourceName: card.sourceName,
        tone: state.tone,
        lang: state.lang,
        handle: card.handle,
      }),
    });
    card.headline = out.headline;
    card.body = out.body;
    card.caption = out.caption;
    captionTouched = true;
    syncFields();
    draw();
    toast(out.ai ? (out.usedArticle ? '✦ Rewritten from the full article' : '✦ Rewritten from the summary (article page was unreachable)') : 'Basic rewrite applied — add ANTHROPIC_API_KEY for AI');
  } catch (e) {
    toast(`AI rephrase failed: ${e.message}`, { error: true });
  } finally {
    busy(btn, false);
  }
});

/* image controls */
$('#zoom').addEventListener('input', (e) => {
  card.imgScale = Number(e.target.value) / 100;
  $('#zoomOut').textContent = `${e.target.value}%`;
  draw();
});
$('#dim').addEventListener('input', (e) => {
  card.dim = Number(e.target.value);
  $('#dimOut').textContent = `${card.dim}%`;
  draw();
});
$$('[data-fit]').forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.fit;
    if (mode === 'center') {
      card.imgX = card.imgY = 0;
    } else if (mode === 'cover') {
      resetTransform();
    } else if (card.img) {
      const A = imageArea(card.template);
      const iw = card.img.naturalWidth;
      const ih = card.img.naturalHeight;
      card.imgScale = Math.min(A.w / iw, A.h / ih) / Math.max(A.w / iw, A.h / ih);
      card.imgX = card.imgY = 0;
      syncZoom();
    }
    draw();
  }),
);
$('#upload').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => setImage(r.result);
  r.readAsDataURL(f);
  e.target.value = '';
});
$('#imgUrl').addEventListener('change', (e) => e.target.value && setImage(e.target.value.trim()));

/* drag / wheel / pinch on the canvas */
const pointers = new Map();
let pinchStart = null;
const toCanvas = (dx) => dx * (SIZE / canvas.getBoundingClientRect().width);
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add('dragging');
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), s: card.imgScale };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    card.imgScale = Math.min(4, Math.max(0.3, pinchStart.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.d)));
    syncZoom();
  } else if (pointers.size === 1) {
    card.imgX += toCanvas(e.clientX - prev.x);
    card.imgY += toCanvas(e.clientY - prev.y);
  }
  draw();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (!pointers.size) canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    card.imgScale = Math.min(4, Math.max(0.3, card.imgScale * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
    syncZoom();
    draw();
  },
  { passive: false },
);
canvas.addEventListener('dblclick', () => {
  resetTransform();
  draw();
});

/* style */
function renderStylePickers() {
  $('#tplGrid').innerHTML = TEMPLATES.map((t) => `<button class="tpl ${t.id === card.template ? 'is-active' : ''}" data-id="${t.id}" aria-label="${t.name}"><canvas width="216" height="216"></canvas><span>${t.name}</span></button>`).join('');
  $$('#tplGrid .tpl').forEach((b) => {
    const c2 = $('canvas', b).getContext('2d');
    c2.scale(0.2, 0.2);
    renderCard(c2, Object.assign(Object.create(Object.getPrototypeOf(card), Object.getOwnPropertyDescriptors(card)), { template: b.dataset.id }));
    b.addEventListener('click', () => {
      card.template = b.dataset.id;
      store.set('template', card.template);
      $$('#tplGrid .tpl').forEach((x) => x.classList.toggle('is-active', x === b));
      draw();
    });
  });
  $('#swatches').innerHTML = ACCENTS.map((a) => `<button class="swatch ${a.id === card.accent ? 'is-active' : ''}" style="--c:${a.c}" data-id="${a.id}" title="${a.name}" aria-label="${a.name}"></button>`).join('');
  $$('#swatches .swatch').forEach((b) =>
    b.addEventListener('click', () => {
      card.accent = b.dataset.id;
      store.set('accent', card.accent);
      $$('#swatches .swatch').forEach((x) => x.classList.toggle('is-active', x === b));
      draw();
    }),
  );
}
$('#font').addEventListener('change', async (e) => {
  card.font = e.target.value;
  store.set('font', card.font);
  await document.fonts.ready;
  draw();
});
[['#headSize', 'headSize', '#hsOut'], ['#bodySize', 'bodySize', '#bsOut']].forEach(([sel, key, out]) =>
  $(sel).addEventListener('input', (e) => {
    card[key] = Number(e.target.value);
    $(out).textContent = e.target.value;
    draw();
  }),
);
[['#showBody', 'showBody'], ['#showSource', 'showSource'], ['#breaking', 'breaking']].forEach(([sel, key]) =>
  $(sel).addEventListener('change', (e) => {
    card[key] = e.target.checked;
    draw();
  }),
);
$('#handle').addEventListener('input', (e) => {
  card.handle = e.target.value;
  store.set('handle', card.handle);
  if (!captionTouched) $('#caption').value = card.caption = defaultCaption();
  draw();
});

/* ---------------- export ---------------- */
function snapshot(type = 'image/jpeg', quality = 0.93) {
  clampPan(card);
  renderCard(ctx, card);
  return new Promise((r) => canvas.toBlob(r, type, quality));
}

$('#dlJpg').addEventListener('click', async () => download(await snapshot(), `${slug(card.headline)}.jpg`));
$('#dlPng').addEventListener('click', async () => download(await snapshot('image/png'), `${slug(card.headline)}.png`));
$('#duration').addEventListener('input', (e) => ($('#durOut').textContent = `${e.target.value}s`));

async function makeReel() {
  if (state.busy) return null;
  state.busy = true;
  $('#recOverlay').hidden = false;
  $$('#view-3 button, #view-3 input, #view-3 textarea, #view-3 select').forEach((el) => (el.dataset.wasDisabled = el.disabled, (el.disabled = true)));
  try {
    const dur = Number($('#duration').value);
    return await recordReel(canvas, (anim) => renderCard(ctx, card, anim), dur, (p) => ($('#recText').textContent = `Recording reel… ${Math.round(p * 100)}%`));
  } finally {
    state.busy = false;
    $('#recOverlay').hidden = true;
    $$('#view-3 [data-was-disabled]').forEach((el) => ((el.disabled = el.dataset.wasDisabled === 'true'), delete el.dataset.wasDisabled));
    draw();
  }
}

async function uploadMedia(blob, normalize = false) {
  const res = await fetch(`/api/media${normalize ? '?normalize=1' : ''}`, { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

$('#dlReel').addEventListener('click', async () => {
  const btn = $('#dlReel');
  try {
    const blob = await makeReel();
    if (!blob) return;
    if (/mp4/.test(blob.type)) return download(blob, `${slug(card.headline)}-reel.mp4`);
    if (state.config.features.transcode) {
      busy(btn, true);
      toast('Converting to MP4…');
      const up = await uploadMedia(blob);
      const mp4 = await (await fetch(up.path)).blob();
      return download(mp4, `${slug(card.headline)}-reel.mp4`);
    }
    download(blob, `${slug(card.headline)}-reel.webm`);
    toast('Saved as WebM — this browser cannot record MP4 and the server has no ffmpeg.');
  } catch (e) {
    toast(`Reel failed: ${e.message}`, { error: true });
  } finally {
    busy(btn, false);
  }
});

$('#previewReel').addEventListener('click', () => {
  if (state.busy) return;
  const dur = Number($('#duration').value);
  const t0 = performance.now();
  state.busy = true;
  const frame = (now) => {
    const t = (now - t0) / 1000;
    renderCard(ctx, card, { t: Math.min(t, dur), dur });
    if (t < dur) requestAnimationFrame(frame);
    else {
      state.busy = false;
      draw();
    }
  };
  requestAnimationFrame(frame);
});

async function postToInstagram(kind) {
  if (!state.config.features.instagram) return $('#igSetup').showModal();
  const btn = kind === 'video' ? $('#igReel') : $('#igImage');
  if (!card.caption.trim()) return toast('Add a caption first (Copy tab).', { error: true });
  try {
    let blob;
    if (kind === 'video') {
      blob = await makeReel();
      if (!blob) return;
    } else blob = await snapshot('image/jpeg', 0.92);
    busy(btn, true);
    toast(kind === 'video' ? 'Uploading reel… Instagram may take a minute to process it.' : 'Posting to Instagram…', { ms: 60000 });
    const up = await uploadMedia(blob, kind === 'video');
    const out = await api('/api/instagram/publish', { method: 'POST', body: JSON.stringify({ name: up.name, kind, caption: card.caption }) });
    toast(out.permalink ? `Posted! <a href="${esc(out.permalink)}" target="_blank" rel="noopener">View on Instagram ↗</a>` : 'Posted to Instagram!', { html: true, ms: 8000 });
  } catch (e) {
    toast(`Instagram: ${e.message}`, { error: true, ms: 8000 });
  } finally {
    busy(btn, false);
  }
}
$('#igImage').addEventListener('click', () => postToInstagram('image'));
$('#igReel').addEventListener('click', () => postToInstagram('video'));

/* ---------------- boot ---------------- */
async function boot() {
  try {
    state.config = await api('/api/config');
  } catch (e) {
    document.body.innerHTML = `<main><div class="empty">Server not reachable: ${esc(e.message)}</div></main>`;
    return;
  }
  const f = state.config.features;
  if (!card.handle && state.config.handle) card.handle = state.config.handle;
  $('#flags').innerHTML = [
    ['AI', f.ai],
    ['Instagram', f.instagram],
    ['X', f.x],
    ...(f.mock ? [['Mock data', true]] : []),
  ]
    .map(([n, on]) => `<span class="flag ${on ? 'on' : ''}" title="${on ? 'Configured' : 'Not configured on the server'}">${on ? '●' : '○'} ${n}</span>`)
    .join('');
  $('#igNote').textContent = f.instagram
    ? 'Publishes straight to your connected Business/Creator account.'
    : 'Not connected yet — click to see what the server needs.';
  if (!pickMime().includes('mp4') && !f.transcode) $('#dlReel').textContent = '⬇ Record & download WebM';
  renderSources();
}
boot();
