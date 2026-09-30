import { renderCard, SIZE, ACCENTS, TEMPLATES, imageArea, clampPan } from './render.js';
import { recordReel, pickMime, audioContext, playMusic } from './reel.js';

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
  const GROUPS = [
    { id: 'national', label: 'National · English' },
    { id: 'tamil', label: 'Tamil · தமிழ்' },
  ];
  const card = (s) => `<button class="source-card" style="--c:${s.color}" data-id="${s.id}" aria-pressed="${state.sources.has(s.id)}">
        <span class="s-name"><span class="s-dot"></span>${esc(s.name)}</span>
        <span class="s-meta">${esc(s.domain)}${s.only ? ' · cinema & TN only' : ` · @${esc(s.x)}`}</span>
        <span class="s-check">✓</span>
      </button>`;
  $('#sourceGrid').innerHTML = GROUPS.map((g) => {
    const list = sources.filter((s) => (s.group || 'national') === g.id);
    return list.length
      ? `<div class="source-group"><div class="group-head"><h3>${g.label} <span class="group-count" data-count="${g.id}"></span></h3><button class="link" data-group="${g.id}"></button></div><div class="source-grid-inner">${list.map(card).join('')}</div></div>`
      : '';
  }).join('');
  // Tap any channel to toggle it — pick as many as you like, from either group.
  $$('#sourceGrid .source-card').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.id;
      state.sources.has(id) ? state.sources.delete(id) : state.sources.add(id);
      syncSourceCards();
    }),
  );
  // "Select all / Clear" shortcut per group.
  $$('#sourceGrid [data-group]').forEach((b) =>
    b.addEventListener('click', () => {
      const ids = sources.filter((s) => (s.group || 'national') === b.dataset.group).map((s) => s.id);
      const allOn = ids.every((id) => state.sources.has(id));
      ids.forEach((id) => (allOn ? state.sources.delete(id) : state.sources.add(id)));
      syncSourceCards();
    }),
  );
  syncSourceCards();
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

function syncSourceCards() {
  $$('#sourceGrid .source-card').forEach((c) => c.setAttribute('aria-pressed', state.sources.has(c.dataset.id)));
  $$('#sourceGrid [data-group]').forEach((b) => {
    const ids = state.config.sources.filter((s) => (s.group || 'national') === b.dataset.group).map((s) => s.id);
    const on = ids.filter((id) => state.sources.has(id)).length;
    b.textContent = on === ids.length ? 'Clear group' : 'Select all in group';
    const cnt = $(`[data-count="${b.dataset.group}"]`);
    if (cnt) cnt.textContent = on ? `· ${on} of ${ids.length} selected` : '';
  });
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
  syncSourceCards();
});
$('#selNone').addEventListener('click', () => {
  state.sources.clear();
  syncSourceCards();
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
      if (s.via === 'unsupported') return `<span class="status-pill skip" style="--c:${src?.color}" title="${esc(s.errors[0] || '')}"><span class="d"></span>${esc(s.name)} · n/a</span>`;
      const cls = !s.count ? 'err' : s.via === 'gnews' ? 'gn' : '';
      const how = { rss: 'RSS feed', 'rss+page': 'RSS + section page', page: 'section page', gnews: 'Google News (no images — add one in the studio)' }[s.via] || '';
      const tip = !s.count ? s.errors.join('\n') : `${how}\n${s.feed || ''}`;
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
    const m = await selectedMusic();
    $('#recText').textContent = 'Recording reel…';
    return await recordReel(canvas, (anim) => renderCard(ctx, card, anim), dur, (p) => ($('#recText').textContent = `Recording reel… ${Math.round(p * 100)}%`), m);
  } finally {
    state.busy = false;
    $('#recOverlay').hidden = true;
    $$('#view-3 [data-was-disabled]').forEach((el) => ((el.disabled = el.dataset.wasDisabled === 'true'), delete el.dataset.wasDisabled));
    draw();
  }
}

async function uploadMedia(blob, normalize = false) {
  const q = new URLSearchParams();
  if (normalize) q.set('normalize', '1');
  if (blob.hasAudio) q.set('audio', '1');
  const res = await fetch(`/api/media?${q}`, { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

$('#dlReel').addEventListener('click', async () => {
  const btn = $('#dlReel');
  stopPreviewTrack();
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

async function previewReel() {
  if (state.busy) return;
  stopPreviewTrack();
  const dur = Number($('#duration').value);
  state.busy = true;
  let src = null;
  try {
    const m = await selectedMusic();
    if (m) {
      const actx = audioContext();
      if (actx.state === 'suspended') await actx.resume();
      src = playMusic(actx, actx.destination, m, dur);
    }
  } catch (e) {
    toast(`Couldn't play music: ${e.message}`, { error: true });
  }
  const t0 = performance.now();
  const frame = (now) => {
    const t = (now - t0) / 1000;
    renderCard(ctx, card, { t: Math.min(t, dur), dur });
    if (t < dur) requestAnimationFrame(frame);
    else {
      state.busy = false;
      try { src?.stop(); } catch {}
      draw();
    }
  };
  requestAnimationFrame(frame);
}
$('#previewReel').addEventListener('click', previewReel);
$('#previewReel2').addEventListener('click', previewReel);

/* ---------------- music ---------------- */
const music = {
  catalog: [],
  id: store.get('musicId', 'none'),
  volume: store.get('musicVol', 80),
  start: 0,
  custom: null, // { name, url }
  buffers: new Map(),
  preview: null, // { id, audio }
};

async function loadCatalog() {
  try {
    music.catalog = await (await fetch('/music/catalog.json')).json();
  } catch {
    music.catalog = [];
  }
  if (music.id !== 'none' && !music.catalog.some((t) => t.id === music.id)) music.id = 'none';
  $('#musicVol').value = music.volume;
  $('#mvolOut').textContent = `${music.volume}%`;
  renderTracks();
}

function trackRows() {
  const rows = [{ id: 'none', title: 'No music', mood: 'Silent reel' }, ...music.catalog];
  if (music.custom) rows.push({ id: 'custom', title: music.custom.name, mood: 'Uploaded track', file: music.custom.url });
  return rows;
}

function renderTracks() {
  let lastGroup = null;
  $('#trackList').innerHTML = trackRows()
    .map((t) => {
      const playing = music.preview?.id === t.id;
      const group = t.id === 'none' ? null : t.id === 'custom' ? 'Your upload' : t.group || 'Background beds';
      const head = group && group !== lastGroup ? `<div class="mgroup">${esc(group)}</div>` : '';
      lastGroup = group || lastGroup;
      return `${head}<div class="mtrack" role="radio" tabindex="0" aria-checked="${t.id === music.id}" data-id="${esc(t.id)}">
        ${t.file ? `<button class="play ${playing ? 'is-playing' : ''}" data-play="${esc(t.id)}" aria-label="${playing ? 'Pause' : 'Play'} ${esc(t.title)}">${playing ? '❚❚' : '▶'}</button>` : '<span class="play" aria-hidden="true">∅</span>'}
        <span><span class="t-name">${esc(t.title)}${playing ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}</span><span class="t-meta">${esc(t.mood || '')}${t.bpm ? ` · ${t.bpm} bpm` : ''}</span></span>
        <span class="t-tick">✓</span>
      </div>`;
    })
    .join('');
  $$('#trackList .mtrack').forEach((row) => {
    const pick = () => {
      music.id = row.dataset.id;
      if (music.id !== 'custom') store.set('musicId', music.id);
      renderTracks();
      updateMusicNote();
    };
    row.addEventListener('click', (e) => (e.target.closest('[data-play]') ? null : pick()));
    row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  $$('#trackList [data-play]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePreviewTrack(b.dataset.play);
    }),
  );
}

function trackById(id) {
  return trackRows().find((t) => t.id === id);
}

function stopPreviewTrack() {
  if (music.preview) {
    music.preview.audio.pause();
    music.preview = null;
    renderTracks();
  }
}

function togglePreviewTrack(id) {
  const was = music.preview?.id;
  stopPreviewTrack();
  if (was === id) return;
  const t = trackById(id);
  const audio = new Audio(t.file);
  audio.volume = music.volume / 100;
  audio.currentTime = music.start;
  audio.play().catch((e) => toast(`Can't play: ${e.message}`, { error: true }));
  audio.onended = stopPreviewTrack;
  music.preview = { id, audio };
  // pick it too — previewing usually means choosing
  music.id = id;
  if (id !== 'custom') store.set('musicId', id);
  renderTracks();
  updateMusicNote();
}

async function selectedMusic() {
  if (music.id === 'none') return null;
  const t = trackById(music.id);
  if (!t?.file) return null;
  const actx = audioContext();
  if (!actx) throw new Error('This browser has no Web Audio support.');
  let buffer = music.buffers.get(t.file);
  if (!buffer) {
    const data = await (await fetch(t.file)).arrayBuffer();
    buffer = await new Promise((res, rej) => actx.decodeAudioData(data, res, rej));
    music.buffers.set(t.file, buffer);
  }
  return { buffer, volume: music.volume / 100, offset: music.start };
}

function updateMusicNote() {
  const t = trackById(music.id);
  $('#reelMusicNote').textContent = `${music.id === 'none' ? 'No music' : `♪ ${t?.title}`} · change it in the Music tab. Keep this tab in front while recording.`;
}

$('#musicVol').addEventListener('input', (e) => {
  music.volume = Number(e.target.value);
  $('#mvolOut').textContent = `${music.volume}%`;
  store.set('musicVol', music.volume);
  if (music.preview) music.preview.audio.volume = music.volume / 100;
});
$('#musicStart').addEventListener('input', (e) => {
  music.start = Number(e.target.value);
  $('#mstartOut').textContent = `${music.start}s`;
  if (music.preview) music.preview.audio.currentTime = music.start;
});
$('#musicUpload').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (f.size > 30e6) return toast('That file is over 30 MB — pick a shorter track.', { error: true });
  if (music.custom) URL.revokeObjectURL(music.custom.url);
  music.custom = { name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), url: URL.createObjectURL(f) };
  music.id = 'custom';
  renderTracks();
  updateMusicNote();
  e.target.value = '';
});
// stop previews when leaving the Music tab
$$('.inspector .tab').forEach((t) => t.addEventListener('click', () => t.dataset.panel !== 'music' && stopPreviewTrack()));

async function postToInstagram(kind) {
  stopPreviewTrack();
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


/* ---------------- video grabber ---------------- */
const grab = { info: null, quality: 'best', job: null, timer: null, from: 1 };
const PLATFORM_COLORS = { YouTube: '#FF0033', X: '#E7E9EA', Instagram: '#E1306C', Facebook: '#1877F2', ShareChat: '#FF6F00' };

function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const fmtSize = (b) => (b ? (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`) : '');

function openGrab(prefill = '') {
  const active = $('.view.is-active')?.id?.replace('view-', '');
  if (active && active !== 'grab') grab.from = active;
  go('grab');
  $('#grabOff').hidden = state.config.features.grab;
  if (prefill) $('#grabUrl').value = prefill;
  setTimeout(() => $('#grabUrl').focus(), 50);
}
$('#grabNav').addEventListener('click', () => openGrab());
$('#grabBack').addEventListener('click', () => go(isNaN(Number(grab.from)) ? 1 : Number(grab.from)));

$('#grabPaste').addEventListener('click', async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) {
      $('#grabUrl').value = t;
      $('#grabForm').requestSubmit();
    }
  } catch {
    toast('Clipboard blocked — long-press the box and paste instead.', { error: true });
    $('#grabUrl').focus();
  }
});

$('#grabForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#grabUrl').value.trim().match(/https?:\/\/\S+/)?.[0];
  if (!url) return toast('Paste a link that starts with https://', { error: true });
  const btn = $('#grabFetch');
  busy(btn, true);
  clearInterval(grab.timer);
  $('#grabResult').hidden = true;
  try {
    grab.info = await api('/api/grab/info', { method: 'POST', body: JSON.stringify({ url }) });
    renderGrabInfo();
  } catch (err) {
    toast(err.message, { error: true, ms: 9000 });
  } finally {
    busy(btn, false);
  }
});

function renderGrabInfo() {
  const i = grab.info;
  $('#grabResult').hidden = false;
  $('#grabThumb').src = i.thumbnail ? proxied(i.thumbnail) : '';
  $('#grabThumb').hidden = !i.thumbnail;
  $('#grabPlatform').innerHTML = `<span class="d" style="--c:${PLATFORM_COLORS[i.platform] || '#8B5CF6'}"></span>${esc(i.platform)}`;
  $('#grabDur').textContent = fmtDur(i.duration);
  $('#grabDur').hidden = !i.duration;
  $('#grabTitle').textContent = i.title;
  $('#grabUploader').textContent = [i.uploader, i.height ? `${i.height}p source` : '', i.filesize ? `~${fmtSize(i.filesize)}` : ''].filter(Boolean).join(' · ');
  const opts = [{ id: 'best', label: 'Best' }];
  for (const h of [1080, 720, 480]) if (!i.heights.length || i.heights.some((x) => x >= h)) opts.push({ id: String(h), label: `${h}p` });
  opts.push({ id: 'audio', label: 'Audio (MP3)' });
  grab.quality = i.heights.some((x) => x > 1080) ? '1080' : 'best';
  $('#grabQuality').innerHTML = opts.map((o) => `<button class="chip" role="radio" data-q="${o.id}" aria-checked="${o.id === grab.quality}">${o.label}</button>`).join('');
  $$('#grabQuality .chip').forEach((b) =>
    b.addEventListener('click', () => {
      grab.quality = b.dataset.q;
      $$('#grabQuality .chip').forEach((x) => x.setAttribute('aria-checked', x === b));
      $('#grabGo').textContent = grab.quality === 'audio' ? '⬇ Download MP3' : '⬇ Download MP4';
    }),
  );
  $('#grabGo').textContent = '⬇ Download MP4';
  $('#grabGo').disabled = false;
  $('#grabGo').hidden = false;
  $('#grabProgress').hidden = true;
  $('#grabDone').hidden = true;
  $('#grabCaption').value = `${i.title}\n\n🎥 Credit: ${i.uploader || i.platform} (${i.platform})\n\n#news #viral #trending`;
}

$('#grabGo').addEventListener('click', async () => {
  const btn = $('#grabGo');
  btn.disabled = true;
  $('#grabProgress').hidden = false;
  $('#grabDone').hidden = true;
  $('#grabBar').style.width = '2%';
  $('#grabStage').textContent = 'Starting…';
  try {
    const { id } = await api('/api/grab/start', { method: 'POST', body: JSON.stringify({ url: grab.info.url, quality: grab.quality }) });
    grab.job = { id };
    clearInterval(grab.timer);
    grab.timer = setInterval(() => pollGrab(id), 1000);
  } catch (e) {
    toast(e.message, { error: true, ms: 9000 });
    btn.disabled = false;
    $('#grabProgress').hidden = true;
  }
});

async function pollGrab(id) {
  let j;
  try {
    j = await api(`/api/grab/${id}`);
  } catch (e) {
    clearInterval(grab.timer);
    return toast(e.message, { error: true });
  }
  $('#grabBar').style.width = `${Math.max(2, j.progress)}%`;
  $('#grabStage').textContent = j.stage === 'processing' ? 'Converting to MP4…' : j.stage === 'downloading' ? `Downloading… ${Math.round(j.progress)}%` : 'Starting…';
  if (j.status === 'running') return;
  clearInterval(grab.timer);
  $('#grabGo').disabled = false;
  if (j.status === 'error') {
    $('#grabProgress').hidden = true;
    return toast(j.error || 'Download failed', { error: true, ms: 10000 });
  }
  grab.job = j;
  $('#grabProgress').hidden = true;
  $('#grabGo').hidden = true;
  $('#grabDone').hidden = false;
  $('#grabSize').textContent = `· ${fmtSize(j.size)}`;
  const href = `/api/grab/${id}/file?name=${encodeURIComponent(slug(grab.info.title))}`;
  $('#grabSave').href = href;
  const isAudio = /\.mp3$/i.test(j.file || '');
  $('#grabIgBlock').hidden = isAudio;
  // Start the save straight away.
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('#grabToStudio').addEventListener('click', () => {
  const i = grab.info;
  openStudio({
    id: `grab-${grab.job?.id || Date.now()}`,
    kind: 'rss',
    via: 'grab',
    sourceId: 'grab',
    sourceName: i.uploader ? `${i.uploader} · ${i.platform}` : i.platform,
    sourceColor: PLATFORM_COLORS[i.platform] || '#8B5CF6',
    category: state.category,
    title: i.title,
    summary: i.description || '',
    link: i.url,
    image: i.thumbnail || '',
    video: '',
    published: new Date().toISOString(),
  });
});

$('#grabIg').addEventListener('click', async () => {
  if (!state.config.features.instagram) return $('#igSetup').showModal();
  const btn = $('#grabIg');
  const caption = $('#grabCaption').value.trim();
  if (!caption) return toast('Add a caption first.', { error: true });
  busy(btn, true);
  toast('Preparing the video for Instagram… this can take a minute.', { ms: 90000 });
  try {
    const out = await api('/api/instagram/publish', { method: 'POST', body: JSON.stringify({ name: grab.job.file, kind: 'video', caption }) });
    toast(out.permalink ? `Posted! <a href="${esc(out.permalink)}" target="_blank" rel="noopener">View on Instagram ↗</a>` : 'Posted to Instagram!', { html: true, ms: 8000 });
  } catch (e) {
    toast(`Instagram: ${e.message}`, { error: true, ms: 9000 });
  } finally {
    busy(btn, false);
  }
});

// Links shared to the app (e.g. /?grab=https://…) open straight in the grabber.
function checkGrabParam() {
  const u = new URLSearchParams(location.search).get('grab');
  if (u) {
    openGrab(u);
    $('#grabForm').requestSubmit();
  }
}


/* ---------------- video editor: crop / trim / music ---------------- */
const ve = {
  name: null, title: 'video', info: null,
  crop: { top: 0, bottom: 0, left: 0, right: 0 }, aspect: 'free',
  start: 0, end: 0,
  music: store.get('veMusic', 'none'), musicFile: null, musicUrl: null, musicName: '',
  musicVol: 80, origVol: 100, job: null, timer: null, audio: null, playing: false,
};
const fmtT = (t) => fmtDur(Math.max(0, t)) || '0:00';

async function openEditor(name, title) {
  ve.name = name;
  ve.title = title || 'video';
  ve.job = null;
  stopVePreview();
  $('#veEditor').hidden = false;
  $('#veDone').hidden = true;
  $('#veProgress').hidden = true;
  $('#veRender').disabled = true;
  $('#veCaption').value = $('#grabCaption').value || `${ve.title}\n\n#news #viral #trending`;
  try {
    ve.info = await api('/api/video/probe', { method: 'POST', body: JSON.stringify({ name }) });
  } catch (e) {
    $('#veEditor').hidden = true;
    return toast(e.message, { error: true, ms: 8000 });
  }
  const { width, height, duration, hasAudio } = ve.info;
  $('#veFrame').style.aspectRatio = `${width} / ${height}`;
  // Keep tall (phone) videos from overflowing: cap the frame's width by the height limit.
  $('#veFrame').style.width = `min(100%, calc(62vh * ${width / height}))`;
  $('#veVideo').src = `/media/${encodeURIComponent(name)}`;
  ve.start = 0;
  ve.end = duration || 0;
  for (const id of ['#veStart', '#veEnd']) {
    $(id).max = (duration || 0).toFixed(1);
  }
  $('#veStart').value = 0;
  $('#veEnd').value = (duration || 0).toFixed(1);
  $('#veNoAudio').hidden = hasAudio;
  $('#veOvol').disabled = !hasAudio;
  setAspect('free', true);
  renderVeMusic();
  syncTrim();
  $('#veRender').disabled = false;
  $('#veEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function syncCrop() {
  const c = ve.crop;
  const el = $('#veCrop');
  el.style.left = `${c.left}%`;
  el.style.top = `${c.top}%`;
  el.style.width = `${100 - c.left - c.right}%`;
  el.style.height = `${100 - c.top - c.bottom}%`;
  for (const k of ['top', 'bottom', 'left', 'right']) {
    const cap = k === 'top' || k === 'bottom' ? 'Top Bottom' : 'Left Right';
    const input = $(`#ve${k[0].toUpperCase() + k.slice(1)}`);
    input.max = Math.max(45, Math.ceil(c[k]));
    input.value = c[k];
    $(`#ve${k[0].toUpperCase() + k.slice(1)}Out`).textContent = `${Math.round(c[k])}%`;
  }
  if (ve.info) {
    const w = Math.round(ve.info.width * (1 - (c.left + c.right) / 100));
    const h = Math.round(ve.info.height * (1 - (c.top + c.bottom) / 100));
    $('#veDims').textContent = `${w} × ${h}`;
  }
}

function setAspect(a, reset = false) {
  ve.aspect = a;
  $$('#veAspect .chip').forEach((b) => b.setAttribute('aria-checked', b.dataset.a === a));
  if (!ve.info) return;
  if (a === 'free') {
    if (reset) ve.crop = { top: 0, bottom: 0, left: 0, right: 0 };
    return syncCrop();
  }
  const [rw, rh] = a.split(':').map(Number);
  const R = rw / rh;
  const S = ve.info.width / ve.info.height;
  if (S > R) {
    const side = ((1 - R / S) / 2) * 100;
    ve.crop = { top: 0, bottom: 0, left: side, right: side };
  } else {
    const side = ((1 - S / R) / 2) * 100;
    ve.crop = { top: side, bottom: side, left: 0, right: 0 };
  }
  syncCrop();
}
$$('#veAspect .chip').forEach((b) => b.addEventListener('click', () => setAspect(b.dataset.a, true)));
$('#veReset').addEventListener('click', () => setAspect('free', true));

for (const k of ['top', 'bottom', 'left', 'right']) {
  const cap = k[0].toUpperCase() + k.slice(1);
  $(`#ve${cap}`).addEventListener('input', (e) => {
    const other = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[k];
    ve.crop[k] = Math.min(Number(e.target.value), 90 - ve.crop[other]);
    if (ve.aspect !== 'free') {
      ve.aspect = 'free';
      $$('#veAspect .chip').forEach((b) => b.setAttribute('aria-checked', b.dataset.a === 'free'));
    }
    syncCrop();
  });
}

// Drag the crop box to reposition it (keeps its size).
{
  let drag = null;
  const box = $('#veCrop');
  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, crop: { ...ve.crop } };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = $('#veFrame').getBoundingClientRect();
    const dx = ((e.clientX - drag.x) / r.width) * 100;
    const dy = ((e.clientY - drag.y) / r.height) * 100;
    const h = drag.crop.left + drag.crop.right;
    const v = drag.crop.top + drag.crop.bottom;
    ve.crop.left = Math.max(0, Math.min(h, drag.crop.left + dx));
    ve.crop.right = h - ve.crop.left;
    ve.crop.top = Math.max(0, Math.min(v, drag.crop.top + dy));
    ve.crop.bottom = v - ve.crop.top;
    syncCrop();
  });
  const end = () => (drag = null);
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

function syncTrim() {
  ve.start = Number($('#veStart').value);
  ve.end = Number($('#veEnd').value);
  if (ve.end - ve.start < 0.5) {
    ve.end = Math.min(ve.info?.duration || ve.start + 0.5, ve.start + 0.5);
    $('#veEnd').value = ve.end;
  }
  $('#veStartOut').textContent = fmtT(ve.start);
  $('#veEndOut').textContent = fmtT(ve.end);
  $('#veLen').textContent = `Length ${(ve.end - ve.start).toFixed(1)}s`;
}
$('#veStart').addEventListener('input', () => {
  syncTrim();
  $('#veVideo').currentTime = ve.start;
});
$('#veEnd').addEventListener('input', () => {
  syncTrim();
  $('#veVideo').currentTime = ve.end;
});
$('#veSetStart').addEventListener('click', () => {
  $('#veStart').value = $('#veVideo').currentTime.toFixed(1);
  syncTrim();
});
$('#veSetEnd').addEventListener('click', () => {
  $('#veEnd').value = $('#veVideo').currentTime.toFixed(1);
  syncTrim();
});
$('#veVideo').addEventListener('timeupdate', () => {
  const v = $('#veVideo');
  $('#veTime').textContent = `${fmtT(v.currentTime)} / ${fmtT(ve.info?.duration || 0)}`;
  if (ve.playing && v.currentTime >= ve.end) stopVePreview();
});
$('#veVideo').addEventListener('click', () => (ve.playing ? stopVePreview() : startVePreview()));

/* music */
function veTrackUrl() {
  if (ve.music === 'none') return null;
  if (ve.music === 'custom') return ve.musicUrl;
  return music.catalog.find((t) => t.id === ve.music)?.file || null;
}
function renderVeMusic() {
  const groups = {};
  for (const t of music.catalog) (groups[t.group || 'Background beds'] ||= []).push(t);
  $('#veMusic').innerHTML =
    `<option value="none">No music</option>` +
    Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${t.id}">${esc(t.title)} — ${esc(t.mood)}</option>`).join('')}</optgroup>`).join('') +
    (ve.musicFile ? `<option value="custom">Your track: ${esc(ve.musicName)}</option>` : '');
  if (ve.music === 'custom' && !ve.musicFile) ve.music = 'none';
  if (ve.music !== 'none' && ve.music !== 'custom' && !music.catalog.some((t) => t.id === ve.music)) ve.music = 'none';
  $('#veMusic').value = ve.music;
}
$('#veMusic').addEventListener('change', (e) => {
  ve.music = e.target.value;
  if (ve.music !== 'custom') store.set('veMusic', ve.music);
  if (ve.audio && !ve.playing) stopVeMusicPreview();
});
$('#veMusicUpload').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 40e6) return toast('Pick a track under 40 MB.', { error: true });
  try {
    toast('Uploading your track…');
    const up = await uploadMedia(new Blob([f], { type: f.type || 'audio/mpeg' }));
    if (ve.musicUrl?.startsWith('blob:')) URL.revokeObjectURL(ve.musicUrl);
    ve.musicFile = up.name;
    ve.musicUrl = URL.createObjectURL(f);
    ve.musicName = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
    ve.music = 'custom';
    renderVeMusic();
    toast('Track added ✓');
  } catch (err) {
    toast(err.message, { error: true });
  }
});
function stopVeMusicPreview() {
  ve.audio?.pause();
  ve.audio = null;
  $('#veMusicPlay').textContent = '▶';
}
$('#veMusicPlay').addEventListener('click', () => {
  if (ve.audio) return stopVeMusicPreview();
  const url = veTrackUrl();
  if (!url) return toast('Pick a track first.');
  ve.audio = new Audio(url);
  ve.audio.volume = Math.min(1, ve.musicVol / 100);
  ve.audio.play();
  ve.audio.onended = stopVeMusicPreview;
  $('#veMusicPlay').textContent = '❚❚';
});
$('#veMvol').addEventListener('input', (e) => {
  ve.musicVol = Number(e.target.value);
  $('#veMvolOut').textContent = `${ve.musicVol}%`;
  if (ve.audio) ve.audio.volume = Math.min(1, ve.musicVol / 100);
});
$('#veOvol').addEventListener('input', (e) => {
  ve.origVol = Number(e.target.value);
  $('#veOvolOut').textContent = ve.origVol ? `${ve.origVol}%` : 'Muted';
  $('#veVideo').volume = Math.min(1, ve.origVol / 100);
});

/* preview: video from trim start + music together */
function startVePreview() {
  stopVeMusicPreview();
  const v = $('#veVideo');
  v.currentTime = ve.start;
  v.volume = Math.min(1, ve.origVol / 100);
  v.muted = ve.origVol === 0;
  v.play();
  const url = veTrackUrl();
  if (url) {
    ve.audio = new Audio(url);
    ve.audio.volume = Math.min(1, ve.musicVol / 100);
    ve.audio.play();
  }
  ve.playing = true;
  $('#vePlay').textContent = '❚❚ Stop';
}
function stopVePreview() {
  const v = $('#veVideo');
  if (v) v.pause();
  ve.audio?.pause();
  ve.audio = null;
  ve.playing = false;
  if ($('#vePlay')) $('#vePlay').textContent = '▶ Play with music';
  if ($('#veMusicPlay')) $('#veMusicPlay').textContent = '▶';
}
$('#vePlay').addEventListener('click', () => (ve.playing ? stopVePreview() : startVePreview()));
$('#veClose').addEventListener('click', () => {
  stopVePreview();
  $('#veEditor').hidden = true;
});

/* render */
$('#veRender').addEventListener('click', async () => {
  stopVePreview();
  const btn = $('#veRender');
  btn.disabled = true;
  $('#veDone').hidden = true;
  $('#veProgress').hidden = false;
  $('#veBar').style.width = '2%';
  $('#veStage').textContent = 'Rendering…';
  try {
    const body = {
      source: ve.name, crop: ve.crop, aspect: ve.aspect === 'free' ? null : ve.aspect, start: ve.start, end: ve.end,
      music: ve.music, musicFile: ve.musicFile, musicVol: ve.musicVol / 100, origVol: ve.origVol / 100,
    };
    const { id } = await api('/api/video/edit', { method: 'POST', body: JSON.stringify(body) });
    clearInterval(ve.timer);
    ve.timer = setInterval(() => pollEdit(id), 800);
  } catch (e) {
    toast(e.message, { error: true, ms: 8000 });
    btn.disabled = false;
    $('#veProgress').hidden = true;
  }
});

async function pollEdit(id) {
  let j;
  try {
    j = await api(`/api/video/edit/${id}`);
  } catch (e) {
    clearInterval(ve.timer);
    $('#veRender').disabled = false;
    return toast(e.message, { error: true });
  }
  $('#veBar').style.width = `${Math.max(2, j.progress)}%`;
  $('#veStage').textContent = `Rendering… ${Math.round(j.progress)}%`;
  if (j.status === 'running') return;
  clearInterval(ve.timer);
  $('#veRender').disabled = false;
  $('#veProgress').hidden = true;
  if (j.status === 'error') return toast(j.error, { error: true, ms: 10000 });
  ve.job = j;
  $('#veDone').hidden = false;
  $('#veInfo').textContent = `· ${j.width}×${j.height} · ${j.duration.toFixed(1)}s · ${fmtSize(j.size)}`;
  $('#veSave').href = `/api/video/edit/${id}/file?name=${encodeURIComponent(slug(ve.title))}`;
  toast('Video ready ✓');
}

$('#vePreviewOut').addEventListener('click', () => {
  if (!ve.job?.file) return;
  const w = window.open('', '_blank');
  if (w) w.location = `/media/${encodeURIComponent(ve.job.file)}`;
});

$('#veIg').addEventListener('click', async () => {
  if (!state.config.features.instagram) return $('#igSetup').showModal();
  const caption = $('#veCaption').value.trim();
  if (!caption) return toast('Add a caption first.', { error: true });
  const btn = $('#veIg');
  busy(btn, true);
  toast('Posting to Instagram… this can take a minute.', { ms: 90000 });
  try {
    const out = await api('/api/instagram/publish', { method: 'POST', body: JSON.stringify({ name: ve.job.file, kind: 'video', caption }) });
    toast(out.permalink ? `Posted! <a href="${esc(out.permalink)}" target="_blank" rel="noopener">View on Instagram ↗</a>` : 'Posted to Instagram!', { html: true, ms: 8000 });
  } catch (e) {
    toast(`Instagram: ${e.message}`, { error: true, ms: 9000 });
  } finally {
    busy(btn, false);
  }
});

/* entry points */
$('#grabEdit').addEventListener('click', () => {
  if (!grab.job?.file) return;
  if (/\.mp3$/i.test(grab.job.file)) return toast('That download is audio only — pick a video quality to edit.', { error: true });
  openEditor(grab.job.file, grab.info?.title);
});
$('#veUpload').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 300e6) return toast('Pick a video under 300 MB.', { error: true });
  const label = e.target.closest('label');
  label.classList.add('is-loading');
  try {
    const up = await uploadMedia(new Blob([f], { type: f.type || 'video/mp4' }));
    $('#grabResult').hidden = true;
    await openEditor(up.name, f.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    label.classList.remove('is-loading');
  }
});

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
  loadCatalog().then(updateMusicNote);
  checkGrabParam();
}
boot();
