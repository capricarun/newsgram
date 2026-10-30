import { renderCard, SIZE, ACCENTS, TEMPLATES, imageArea, clampPan, mediaSize } from './render.js';
import { recordReel, pickMime, audioContext, playMusic } from './reel.js';
import { initSave, saveFile, chooseFolder, clearFolder, onFolderChange, supportsFolders, cleanName, folderName, primeSave } from './save.js';

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

// Video background for "video news" cards: { el, src, name, duration, node, gain, volume, sound }.
let vbg = null;

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

const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp', 'video/x-msvideo', 'video/mpeg', 'video/x-m4v', 'video/ogg'];
const isVideoFile = (f) => /^video\//.test(f?.type || '') || /\.(mp4|m4v|mov|webm|mkv|3gp|avi|mpe?g)$/i.test(f?.name || '');
/** A video File as a Blob with a content type the server accepts (ffmpeg reads the real format). */
const videoBlob = (f) => new Blob([f], { type: VIDEO_TYPES.includes(f.type) ? f.type : 'video/mp4' });

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

/* ---------------- save as (name + folder) ---------------- */
const readable = (t) => cleanName(String(t || '').replace(/\*/g, '').replace(/[#@]/g, '').slice(0, 80), 'newsgram');

/** Saves using the name typed in the row `key` (ed / grab / st). */
async function doSave(source, key, ext, { askWhere = false, fallbackName = 'newsgram' } = {}) {
  const input = $(`#${key}FileName`);
  const name = cleanName(input?.value || fallbackName);
  if (input && !input.value.trim()) input.value = name;
  try {
    const r = await saveFile(source, name, ext, { askWhere });
    if (!r) return null;
    if (r.folderBlocked && r.where === 'download')
      toast(`Couldn't open “${r.folder}”, so it went to your Downloads folder as “${r.name}”. Tap a Save button to put it in the folder.`, { ms: 9000 });
    else toast(r.where === 'folder' ? `Saved to “${r.folder}/${r.name}” ✓` : r.where === 'picker' ? `Saved “${r.name}” ✓` : `Downloading “${r.name}”…`);
    return r;
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, { error: true, ms: 8000 });
    return null;
  }
}

function syncFolderChips(folder) {
  const pick = supportsFolders();
  $$('[data-folder]').forEach((el) => {
    el.textContent = folder ? `📁 ${folder.name}` : pick ? '📁 Ask me each time' : "📁 Browser's Downloads folder";
    el.title = folder ? 'Files are saved straight into this folder' : pick ? 'A Save dialog lets you pick the folder' : 'This browser saves to its Downloads folder (on iPhone: Share → Save to Files)';
  });
  $$('[data-choose]').forEach((b) => {
    b.hidden = !pick;
    b.textContent = folder ? 'Change folder' : 'Choose folder';
  });
  $$('[data-reset]').forEach((b) => (b.hidden = !folder));
  $$('[data-saveas]').forEach((b) => (b.hidden = !pick));
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-choose]')) {
    try {
      const h = await chooseFolder();
      if (h) toast(`New files will be saved in “${h.name}” ✓`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  } else if (e.target.closest('[data-reset]')) {
    await clearFolder();
    toast('Folder cleared — you\'ll be asked where to save.');
  }
});

/* ---------------- steps ---------------- */
const nav = { image: 1, video: 'grab' };
function go(step) {
  const mode = step === 'grab' || step === 'edit' || step === 'audio' ? 'video' : 'image';
  nav[mode] = step;
  $$('.mode').forEach((m) => {
    m.classList.toggle('is-active', m.dataset.mode === mode);
    m.setAttribute('aria-selected', m.dataset.mode === mode);
  });
  $('.stepper').hidden = mode !== 'image';
  $('.vtabs').hidden = mode !== 'video';
  $$('.vtab').forEach((t) => t.classList.toggle('is-active', t.dataset.v === step));
  if (mode === 'image' && typeof edPause === 'function') edPause();
  if (step !== 'audio' && typeof auStop === 'function' && au.playing) auStop();
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${step}`));
  $$('.step').forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle('is-active', n === step);
    b.classList.toggle('is-done', n < step);
  });
  if (step === 2 || (step > 2 && state.news)) $('.step[data-step="2"]').disabled = false;
  if (step === 3) $('.step[data-step="3"]').disabled = false;
  if (vbg) {
    if (step === 3) vbg.el.play().catch(() => {}), requestAnimationFrame(vloop);
    else vbg.el.pause();
    renderVbg();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (step === 'audio') requestAnimationFrame(() => auRender());
}
$$('.step').forEach((b) => b.addEventListener('click', () => !b.disabled && go(Number(b.dataset.step))));
$$('.mode').forEach((m) =>
  m.addEventListener('click', () => {
    if (m.dataset.mode === 'image') go(nav.image);
    else if (nav.video === 'edit') openEditorView();
    else if (nav.video === 'audio') go('audio');
    else openGrab();
  }),
);

/* ---------------- step 1: sources ---------------- */
function renderSources() {
  const { sources, categories, features } = state.config;
  const GROUPS = [
    { id: 'national', label: 'National · English' },
    { id: 'tamil', label: 'Tamil · தமிழ்' },
  ];
  const card = (s) => `<button class="source-card" style="--c:${s.color}" data-id="${s.id}" aria-pressed="${state.sources.has(s.id)}" title="${esc(s.domain)}"><span class="s-dot"></span>${esc(s.name)}</button>`;
  $('#sourceGrid').innerHTML = GROUPS.map((g) => {
    const list = sources.filter((s) => (s.group || 'national') === g.id);
    return list.length
      ? `<div class="source-group"><div class="group-head"><h3>${g.label} <span class="group-count" data-count="${g.id}"></span></h3><span class="sel-actions"><button class="sel-btn all sm" data-group="${g.id}" data-act="all">✓ All</button><button class="sel-btn clear sm" data-group="${g.id}" data-act="clear">✕ Clear</button></span></div><div class="source-grid-inner">${list.map(card).join('')}</div></div>`
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
      ids.forEach((id) => (b.dataset.act === 'all' ? state.sources.add(id) : state.sources.delete(id)));
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

  $('#ownCat').innerHTML = categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
  $('#ownCat').value = state.category;

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
    b.disabled = b.dataset.act === 'all' ? on === ids.length : on === 0;
    const cnt = $(`[data-count="${b.dataset.group}"]`);
    if (cnt) cnt.textContent = on ? `· ${on}/${ids.length}` : '';
  });
  const total = state.config.sources.length;
  $('#selAll').disabled = state.sources.size === total;
  $('#selNone').disabled = state.sources.size === 0;
  updatePick();
}

function updatePick() {
  const n = state.sources.size;
  const cat = state.config.categories.find((c) => c.id === state.category)?.label;
  $('#pickSummary').textContent = n ? `${n} source${n > 1 ? 's' : ''} · ${cat}` : 'Pick at least one source';
  $('#fetchBtn').disabled = !n;
  const sc = $('#scopeCount');
  if (sc) sc.textContent = `(${n})`;
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
$('#refreshBtn').addEventListener('click', () => (state.mode === 'search' ? runSearch(state.searchQ, { fresh: true }) : loadNews()));
$('#backTo1').addEventListener('click', () => go(1));
$('#backTo2').addEventListener('click', () => go(state.item?.kind === 'own' ? 1 : 2));

/* ---------------- step 1b: your own story ---------------- */
const own = { image: '', video: null }; // video: { url, name, file }
function setStart(which) {
  $$('.ss').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.start === which);
    b.setAttribute('aria-selected', b.dataset.start === which);
  });
  $$('[data-start-pane]').forEach((p) => (p.hidden = p.dataset.startPane !== which));
  store.set('start', which);
}
$$('.ss').forEach((b) => b.addEventListener('click', () => setStart(b.dataset.start)));
setStart(['own', 'search'].includes(store.get('start')) ? store.get('start') : 'channels');

function syncOwnMedia() {
  $('#ownDrop').classList.toggle('has-img', !!(own.image || own.video));
  $('#ownImgClear').hidden = !(own.image || own.video);
  $('#ownVBadge').hidden = !own.video;
}
function setOwnImage(src) {
  if (src) clearOwnVideo();
  own.image = src || '';
  const img = $('#ownPreview');
  img.hidden = !own.image;
  if (own.image) img.src = proxied(own.image);
  else img.removeAttribute('src');
  syncOwnMedia();
}
function setOwnVideo(f) {
  clearOwnVideo();
  setOwnImage('');
  own.video = { url: URL.createObjectURL(f), name: f.name.replace(/\.[^.]+$/, '').slice(0, 60), file: f };
  const v = $('#ownVideo');
  v.src = own.video.url;
  v.hidden = false;
  v.play().catch(() => {});
  syncOwnMedia();
  updateOwn();
}
function clearOwnVideo() {
  if (!own.video) return;
  const v = $('#ownVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.hidden = true;
  // keep the URL alive if the studio is still playing it
  if (vbg?.src !== own.video.url) URL.revokeObjectURL(own.video.url);
  own.video = null;
  syncOwnMedia();
}
$('#ownVideo').addEventListener('error', () => {
  // Can't preview here (e.g. HEVC in Chrome) — the studio converts it on the server.
  if (own.video) $('#ownVideo').hidden = true;
});
$('#ownPreview').addEventListener('error', () => {
  if (!own.image) return;
  toast("Couldn't load that image — try another or upload one.", { error: true });
  setOwnImage('');
});
function readOwnFile(f) {
  if (f && isVideoFile(f)) {
    if (f.size > 300e6) return toast('That video is over 300 MB — pick a shorter clip.', { error: true });
    return setOwnVideo(f);
  }
  if (!f || !/^image\//.test(f.type)) return toast("That file isn't an image or a video.", { error: true });
  const r = new FileReader();
  r.onload = () => setOwnImage(r.result);
  r.readAsDataURL(f);
}
const drop = $('#ownDrop');
drop.addEventListener('click', () => $('#ownFile').click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('#ownFile').click()));
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')));
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  const f = e.dataTransfer.files?.[0];
  if (f) return readOwnFile(f);
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (/^https?:/i.test(url)) setOwnImage(url.trim());
});
$('#ownFile').addEventListener('change', (e) => {
  readOwnFile(e.target.files?.[0]);
  e.target.value = '';
});
$('#ownImgUrl').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v) setOwnImage(v);
  e.target.value = '';
});
$('#ownImgClear').addEventListener('click', () => (clearOwnVideo(), setOwnImage('')));
// Paste an image anywhere on the "Your own story" screen.
document.addEventListener('paste', (e) => {
  if ($('#view-1').classList.contains('is-active') && !$('[data-start-pane="own"]').hidden) {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      readOwnFile(f);
    }
  }
});

const wordCount = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
function updateOwn() {
  const n = wordCount($('#ownText').value);
  const hasHead = $('#ownTitle').value.trim().length > 0;
  $('#ownCount').textContent = `${n} word${n === 1 ? '' : 's'}`;
  const ok = n > 0 || hasHead;
  $('#ownAsIs').disabled = !ok;
  $('#ownAi').disabled = !ok;
  $('#ownSummary').textContent = ok
    ? own.video ? 'Ready — video news with your copy' : own.image ? 'Ready — image and copy added' : 'Ready — add an image or video now, or in the studio'
    : own.video ? 'Video added — now add your copy' : 'Add your copy to continue';
}
['#ownText', '#ownTitle'].forEach((id) => $(id).addEventListener('input', updateOwn));
$('#ownImgClear').addEventListener('click', updateOwn);
new MutationObserver(updateOwn).observe($('#ownDrop'), { attributes: true, attributeFilter: ['class'] });

function ownItem() {
  const text = $('#ownText').value.trim();
  const head = $('#ownTitle').value.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const firstSentence = (text.match(/^[^.!?\n]+[.!?]?/) || [''])[0].trim();
  const title = head || firstSentence.split(/\s+/).slice(0, 14).join(' ');
  return {
    id: `own-${Date.now()}`,
    kind: 'own',
    sourceId: 'own',
    sourceName: $('#ownCredit').value.trim(),
    sourceColor: '#8B5CF6',
    category: $('#ownCat').value,
    title,
    summary: words.length > 60 ? `${words.slice(0, 60).join(' ')}…` : text,
    text,
    link: '',
    image: own.video ? '' : own.image,
    video: '',
    bgVideo: own.video ? { src: own.video.url, name: own.video.name, file: own.video.file } : null,
    published: new Date().toISOString(),
  };
}
$('#ownAsIs').addEventListener('click', () => openStudio(ownItem()));
$('#ownAi').addEventListener('click', async () => {
  await openStudio(ownItem());
  $('#aiBtn').click();
});

/* ---------------- step 1c: search a story ---------------- */
const search = { scope: store.get('searchScope', 'selected'), range: store.get('searchRange', '7d') };
function syncSearchOpts() {
  $$('[data-scope]').forEach((b) => b.setAttribute('aria-checked', b.dataset.scope === search.scope));
  $$('[data-range]').forEach((b) => b.setAttribute('aria-checked', b.dataset.range === search.range));
  const q = $('#searchQ').value.trim();
  const noChannels = search.scope === 'selected' && !state.sources.size;
  $('#searchBtn').disabled = !q || noChannels;
  const where = search.scope === 'all' ? 'all news sites' : `${state.sources.size} channel${state.sources.size === 1 ? '' : 's'}`;
  const when = { '1d': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' }[search.range];
  $('#searchSummary').textContent = noChannels ? 'Pick channels first, or search all news sites' : q ? `“${q}” · ${where} · ${when}` : 'Type a few keywords';
}
$$('[data-scope]').forEach((b) => b.addEventListener('click', () => ((search.scope = b.dataset.scope), store.set('searchScope', search.scope), syncSearchOpts())));
$$('[data-range]').forEach((b) => b.addEventListener('click', () => ((search.range = b.dataset.range), store.set('searchRange', search.range), syncSearchOpts())));
$('#searchQ').addEventListener('input', syncSearchOpts);
$('.ss[data-start="search"]').addEventListener('click', () => {
  syncSearchOpts();
  setTimeout(() => $('#searchQ').focus(), 0);
});

function renderRecent() {
  const list = store.get('recentSearches', []);
  const el = $('#recentSearches');
  el.hidden = !list.length;
  el.innerHTML = list.length ? `<span class="sec-label">Recent</span>${list.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}` : '';
  $$('#recentSearches [data-q]').forEach((b) => b.addEventListener('click', () => (($('#searchQ').value = b.dataset.q), runSearch(b.dataset.q))));
}
function remember(q) {
  const list = [q, ...store.get('recentSearches', []).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  store.set('recentSearches', list);
  renderRecent();
}

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('#searchBtn').disabled) runSearch($('#searchQ').value);
});
$('#storySearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#storySearchQ').value.trim();
  if (q) (($('#searchQ').value = q), runSearch(q));
});

async function runSearch(raw, { fresh = false } = {}) {
  const q = String(raw || '').trim();
  if (!q) return;
  if (search.scope === 'selected' && !state.sources.size) return toast('Pick some channels first, or search all news sites.', { error: true });
  state.mode = 'search';
  state.searchQ = q;
  remember(q);
  store.set('tone', state.tone);
  store.set('lang', state.lang);
  go(2);
  $('#storySearch').hidden = false;
  $('#storySearchQ').value = q;
  $('#storiesEyebrow').textContent = `Searching “${q}”…`;
  $('#statusRow').innerHTML = '';
  $('#storyTabs').hidden = true;
  $('#storyGrid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton shimmer"></div>').join('');
  busy($('#searchBtn'), true);
  try {
    const params = new URLSearchParams({ q, scope: search.scope, range: search.range, sources: [...state.sources].join(','), category: state.category });
    if (fresh) params.set('t', Date.now());
    const out = await api(`/api/search?${params}`);
    if (state.searchQ !== q) return; // a newer search won
    state.news = { items: out.items, xItems: [], status: [] };
    state.rewrites.clear();
    state.tab = 'rss';
    const where = search.scope === 'all' ? 'all news sites' : `${state.sources.size} channel${state.sources.size === 1 ? '' : 's'}`;
    $('#storiesEyebrow').textContent = `“${q}” · ${out.items.length} result${out.items.length === 1 ? '' : 's'} · ${where}`;
    $('#statusRow').innerHTML = (out.engines || [])
      .map((e) => `<span class="status-pill engine ${e.error ? 'err' : ''}" title="${esc(e.error || '')}"><span class="d"></span>${esc(e.name)} · ${e.error ? 'failed' : e.count}</span>`)
      .join('');
    renderStories();
    rewriteVisible();
  } catch (e) {
    $('#storyGrid').innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`;
  } finally {
    busy($('#searchBtn'), false);
  }
}

/* ---------------- step 2: stories ---------------- */
async function loadNews() {
  store.set('sources', [...state.sources]);
  store.set('category', state.category);
  store.set('includeX', state.includeX);
  store.set('tone', state.tone);
  store.set('lang', state.lang);
  state.mode = 'feeds';
  $('#storySearch').hidden = true;
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
    $('#storyGrid').innerHTML =
      state.mode === 'search'
        ? `<div class="empty">No stories found for “${esc(state.searchQ)}”. Try fewer or different keywords, a longer time range, or <b>All news sites</b>.</div>`
        : `<div class="empty">No stories came back for this selection. Try another category or source — hover the red pills above to see why.</div>`;
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
  const tags = ['#news', '#india', '#newsupdate', `#${(state.item?.category || 'latest').replace(/\W/g, '')}`, `#${(card.sourceName || '').replace(/\W/g, '').toLowerCase()}`].filter((t) => t.length > 1);
  return `${card.headline.replace(/\*/g, '')}\n\n${card.body}\n\n${card.sourceName ? `Source: ${card.sourceName}\n\n` : ''}${tags.join(' ')}${card.handle ? `\n\nFollow ${card.handle} for more` : ''}`;
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
  if (vbg) dropVideo();
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

/* ---------------- video background (video news) ---------------- */
// While a video is set, card.img is the <video>; renderCard draws its current frame.
let vloopRaf = 0;
function vloop() {
  cancelAnimationFrame(vloopRaf);
  if (!vbg) return;
  if (!state.busy && !vbg.el.paused && $('#view-3').classList.contains('is-active')) {
    clampPan(card);
    renderCard(ctx, card);
  }
  vloopRaf = requestAnimationFrame(vloop);
}

/** Uses a video (same-origin /media URL or blob: URL) as the card background. */
async function setVideoBg(src, { name = 'Video', objectUrl = null, file = null } = {}) {
  dropVideo();
  const el = document.createElement('video');
  el.muted = true;
  el.loop = true;
  el.playsInline = true;
  el.preload = 'auto';
  if (!/^blob:/.test(src)) el.crossOrigin = 'anonymous';
  $('#stMedia').appendChild(el);
  const v = { el, src, name, objectUrl, duration: 0, node: null, gain: null, volume: Number($('#vbgVol').value) / 100, sound: $('#vbgSound').checked };
  vbg = v;
  card.imgSrc = `video:${src}`;
  $('#vbgName').textContent = 'Loading video…';
  $('#vbgOn').hidden = false;
  $('#vbgOff').hidden = true;
  const ok = await new Promise((resolve) => {
    const done = (r) => {
      clearTimeout(timer);
      el.onloadeddata = el.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => done(false), 30000);
    el.onloadeddata = () => done(el.videoWidth > 0);
    el.onerror = () => done(false);
    el.src = src;
  });
  if (vbg !== v) return false; // replaced meanwhile
  if (!ok) {
    vbg = null;
    el.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    card.imgSrc = '';
    renderVbg();
    if (file && state.config.features.transcode) {
      // e.g. an iPhone HEVC clip in Chrome: convert to H.264 on the server and try again.
      toast('Converting the video so the browser can play it… this can take a minute.', { ms: 60000 });
      try {
        const up = await uploadMedia(videoBlob(file), true, 'optional');
        return setVideoBg(up.path, { name });
      } catch (e) {
        toast(`Couldn't use that video: ${e.message}`, { error: true, ms: 8000 });
      }
    } else toast("This browser can't play that video — try an MP4 (H.264).", { error: true, ms: 8000 });
    if (!card.img && state.item?.image) setImage(state.item.image);
    return false;
  }
  v.duration = Number.isFinite(el.duration) ? el.duration : 0;
  card.img = el;
  resetTransform();
  el.play().catch(() => {});
  setReelLength();
  renderVbg();
  renderStylePickers();
  $$('#thumbs button').forEach((b) => b.classList.remove('is-active'));
  requestAnimationFrame(vloop);
  return true;
}

function dropVideo() {
  if (!vbg) return;
  const v = vbg;
  vbg = null;
  cancelAnimationFrame(vloopRaf);
  try {
    v.el.pause();
    v.gain?.disconnect();
  } catch {}
  v.el.removeAttribute('src');
  v.el.load();
  v.el.remove();
  if (v.objectUrl) URL.revokeObjectURL(v.objectUrl);
  if (card.img === v.el) card.img = null;
  if (card.imgSrc.startsWith('video:')) card.imgSrc = '';
  setReelLength();
  renderVbg();
}

/** Routes the video's own sound through Web Audio (done once per video). */
function vbgAudio() {
  if (!vbg.node) {
    const actx = audioContext();
    vbg.node = actx.createMediaElementSource(vbg.el);
    vbg.gain = actx.createGain();
    vbg.node.connect(vbg.gain);
    vbg.el.muted = false; // from now on it's only heard where the gain node is connected
  }
  vbg.gain.gain.value = vbg.volume;
  return vbg.gain;
}

/** Rewinds the video to the first frame (paused). */
async function rewindVideo() {
  const el = vbg.el;
  el.pause();
  await new Promise((r) => {
    el.addEventListener('seeked', r, { once: true });
    setTimeout(r, 1500);
    el.currentTime = 0;
  });
}

function setReelLength() {
  const r = $('#duration');
  if (vbg?.duration) {
    r.max = Math.max(5, Math.min(90, Math.ceil(vbg.duration)));
    r.value = Math.min(Number(r.max), 30);
  } else {
    r.max = 15;
    if (Number(r.value) > 15) r.value = 8;
  }
  $('#durOut').textContent = `${r.value}s`;
  $('#reelHead').textContent = vbg ? 'Video news reel (1:1, plays your clip)' : 'Reel (animated 1:1 video)';
}

function renderVbg() {
  $('#vbgOn').hidden = !vbg;
  $('#vbgOff').hidden = !!vbg;
  if (!vbg) return;
  $('#vbgName').textContent = vbg.name;
  $('#vbgDur').textContent = vbg.duration ? `· ${fmtDur(vbg.duration)}` : '';
  $('#vbgPlay').textContent = vbg.el.paused ? '▶ Play' : '❚❚ Pause';
}

$('#vbgPlay').addEventListener('click', () => {
  if (!vbg) return;
  if (vbg.el.paused) vbg.el.play().catch(() => {}), requestAnimationFrame(vloop);
  else vbg.el.pause(), draw();
  setTimeout(renderVbg, 50);
});
$('#vbgRestart').addEventListener('click', async () => {
  if (!vbg) return;
  await rewindVideo();
  vbg.el.play().catch(() => {});
  requestAnimationFrame(vloop);
  renderVbg();
});
$('#vbgRemove').addEventListener('click', () => {
  dropVideo();
  setImage(state.item?.image || state.article?.image || '');
  toast('Video removed — back to an image card.');
});
$('#vbgSound').addEventListener('change', (e) => vbg && (vbg.sound = e.target.checked));
$('#vbgVol').addEventListener('input', (e) => {
  $('#vbgVolOut').textContent = `${e.target.value}%`;
  if (!vbg) return;
  vbg.volume = Number(e.target.value) / 100;
  if (vbg.gain) vbg.gain.gain.value = vbg.volume;
});
$('#vbgUpload').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (!isVideoFile(f)) return toast("That file isn't a video.", { error: true });
  if (f.size > 300e6) return toast('That video is over 300 MB — pick a shorter clip.', { error: true });
  const url = URL.createObjectURL(f);
  setVideoBg(url, { name: f.name.replace(/\.[^.]+$/, ''), objectUrl: url, file: f }).then((ok) => ok && toast('Video news card ✓ — record it from Publish → Reel'));
});

async function openStudio(item) {
  dropVideo();
  $('#reelOut').hidden = true;
  state.item = item;
  state.article = null;
  const rw = state.rewrites.get(item.id);
  const isOwn = item.kind === 'own';
  const cat = state.config.categories.find((c) => c.id === (isOwn || item.search ? item.category : state.category));
  Object.assign(card, {
    headline: rw?.headline || item.title,
    body: rw?.body || (isOwn ? item.summary : item.summary?.slice(0, 260)) || '',
    sourceName: item.kind === 'x' ? state.config.sources.find((s) => s.id === item.sourceId)?.name : item.sourceName,
    sourceColor: item.sourceColor,
    categoryLabel: cat?.id === 'top' ? '' : cat?.label || '',
    dateLabel: new Date(item.published).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    breaking: false,
    img: null,
  });
  captionTouched = false;
  $('#stFileName').value = readable(card.headline);
  card.caption = defaultCaption();
  syncFields();
  $('#origTitle').textContent = item.title;
  $('#origText').textContent = (isOwn ? item.text : item.summary) || '';
  $('#backTo2').textContent = isOwn ? '← Your story' : '← Stories';
  $('#sourceLine').innerHTML = isOwn ? `Your own story${item.sourceName ? ` · credit: ${esc(item.sourceName)}` : ''}` : `Original: <a href="${esc(item.link)}" target="_blank" rel="noopener">${esc(item.sourceName)} ↗</a>${item.postUrl ? ` · <a href="${esc(item.postUrl)}" target="_blank" rel="noopener">X post ↗</a>` : ''}`;
  $('#thumbs').innerHTML = '<p class="muted small">Loading…</p>';
  $('#srcVideos').innerHTML = '<p class="muted small">Checking the article…</p>';
  $('#aiNote').textContent = !state.config.features.ai ? 'AI key not set — uses a basic rewrite.' : isOwn ? 'Rewrites from the copy you entered.' : 'Rewrites from the full original article.';
  go(3);
  await document.fonts.ready;
  setImage(item.image || '');
  if (item.bgVideo) {
    setVideoBg(item.bgVideo.src, item.bgVideo).then((ok) => ok && state.item === item && toast('Video news card ✓ — your headline plays over the clip. Record it from Publish → Reel.', { ms: 6000 }));
  }

  if (item.link && !/^https:\/\/x\.com/.test(item.link)) {
    try {
      state.article = await api(`/api/article?url=${encodeURIComponent(item.link)}`);
    } catch (e) {
      state.article = { images: [], videos: [], error: e.message };
    }
  } else state.article = { images: [], videos: [] };
  if (state.item !== item) return;
  if (!item.image && !item.bgVideo && state.article.image) setImage(state.article.image);
  renderThumbs();
  renderVideos();
}

function renderThumbs() {
  const imgs = [...new Set([state.item.image, ...(state.article?.images || [])].filter(Boolean))];
  const vid = state.item.bgVideo ? `<button data-video class="thumb-video" title="Use the video">▶<span>Video</span></button>` : '';
  $('#thumbs').innerHTML = imgs.length || vid
    ? vid + imgs.map((src) => `<button data-src="${esc(src)}" class="${src === card.imgSrc ? 'is-active' : ''}"><img src="${esc(proxied(src))}" alt="" onerror="this.parentElement.remove()"></button>`).join('')
    : '<p class="muted small">No other images found in the article.</p>';
  $$('#thumbs button[data-src]').forEach((b) => b.addEventListener('click', () => setImage(b.dataset.src)));
  $('#thumbs [data-video]')?.addEventListener('click', () => !vbg && setVideoBg(state.item.bgVideo.src, state.item.bgVideo));
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
        url: it.kind === 'x' || it.kind === 'own' ? '' : it.link,
        text: it.kind === 'own' ? it.text : undefined,
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
    toast(out.ai ? (it.kind === 'own' ? '✦ Rewritten from your copy' : out.usedArticle ? '✦ Rewritten from the full article' : '✦ Rewritten from the summary (article page was unreachable)') : 'Basic rewrite applied — add ANTHROPIC_API_KEY for AI');
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
      const { w: iw, h: ih } = mediaSize(card.img);
      if (!iw || !ih) return;
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

$('#dlJpg').addEventListener('click', async () => doSave(await snapshot(), 'st', 'jpg', { fallbackName: readable(card.headline) }));
$('#dlPng').addEventListener('click', async () => doSave(await snapshot('image/png'), 'st', 'png', { fallbackName: readable(card.headline) }));
$('#duration').addEventListener('input', (e) => ($('#durOut').textContent = `${e.target.value}s`));

async function makeReel() {
  if (state.busy) return null;
  state.busy = true;
  $('#recOverlay').hidden = false;
  $$('#view-3 button, #view-3 input, #view-3 textarea, #view-3 select').forEach((el) => (el.dataset.wasDisabled = el.disabled, (el.disabled = true)));
  try {
    const dur = Number($('#duration').value);
    const m = await selectedMusic();
    let extra = null;
    if (vbg) {
      await rewindVideo();
      const v = vbg;
      extra = {
        connect: (actx, dest) => v.sound && vbgAudio().connect(dest),
        start: () => v.el.play().catch(() => {}),
        stop: () => {
          try { v.gain?.disconnect(); } catch {}
        },
      };
    }
    $('#recText').textContent = 'Recording reel…';
    return await recordReel(canvas, (anim) => renderCard(ctx, card, anim), dur, (p) => ($('#recText').textContent = `Recording reel… ${Math.round(p * 100)}%`), m, extra);
  } finally {
    state.busy = false;
    $('#recOverlay').hidden = true;
    $$('#view-3 [data-was-disabled]').forEach((el) => ((el.disabled = el.dataset.wasDisabled === 'true'), delete el.dataset.wasDisabled));
    if (vbg) vbg.el.play().catch(() => {}), requestAnimationFrame(vloop);
    draw();
  }
}

async function uploadMedia(blob, normalize = false, audio = null) {
  const q = new URLSearchParams();
  if (normalize === 'raw') q.set('raw', '1');
  else if (normalize) q.set('normalize', '1');
  if (audio) q.set('audio', audio);
  else if (blob.hasAudio) q.set('audio', '1');
  const res = await fetch(`/api/media?${q}`, { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] || 'video/mp4' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'Upload failed — the file is too big for the server.' : `Upload failed (server said ${res.status}${res.status >= 502 ? ' — it may have run out of memory or restarted' : ''}).`));
  return data;
}

/* ---- reel output: save to a folder (desktop) or to Photos (iPhone / Android) ---- */
const reelOut = { blob: null, ext: 'mp4', url: '' };
const isPhone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const canShareFiles = (() => {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([new Blob(['x'], { type: 'video/mp4' })], 'x.mp4', { type: 'video/mp4' })] }));
  } catch {
    return false;
  }
})();
const toPhotos = isPhone && canShareFiles;
const reelName = () => `${readable(card.headline)} reel`;

function syncReelOut() {
  const box = $('#reelOut');
  box.hidden = !reelOut.blob;
  if (!reelOut.blob) return;
  const pick = supportsFolders();
  $('#reelToPhotos').hidden = !toPhotos;
  $('#reelToFolder').hidden = toPhotos || !pick;
  $('#reelSaveAs').hidden = toPhotos || !pick;
  $('#reelToFolder').textContent = folderName() ? `📁 Save to “${folderName()}”` : '📁 Choose folder & save';
  $('#reelDownload').textContent = isPhone ? '⬇ Save to Files' : pick ? '⬇ Downloads folder' : '⬇ Download';
  $('#reelOutHint').textContent = toPhotos
    ? 'Opens the share sheet — tap “Save Video” to put it in Photos (you can also share straight to Instagram or WhatsApp).'
    : pick
      ? 'Pick a folder once (e.g. Desktop) — after that, every new video saves there automatically.'
      : "This browser saves to its Downloads folder. To pick a folder, use Chrome or Edge.";
}

async function saveReelToFolder() {
  if (!reelOut.blob) return;
  if (!folderName()) {
    try {
      if (!(await chooseFolder())) return; // cancelled
    } catch (e) {
      return toast(e.message, { error: true });
    }
  }
  return doSave(reelOut.blob, 'st', reelOut.ext, { fallbackName: reelName() });
}

async function saveReelToPhotos() {
  if (!reelOut.blob) return;
  const file = new File([reelOut.blob], `${cleanName($('#stFileName').value || reelName())}.${reelOut.ext}`, { type: reelOut.blob.type || 'video/mp4' });
  try {
    await navigator.share({ files: [file], title: card.headline.replace(/\*/g, '') });
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast(`Couldn't open the share sheet (${e.message}) — saving to Files instead.`, { error: true, ms: 6000 });
    download(reelOut.blob, file.name);
  }
}

$('#reelToFolder').addEventListener('click', saveReelToFolder);
$('#reelSaveAs').addEventListener('click', () => reelOut.blob && doSave(reelOut.blob, 'st', reelOut.ext, { askWhere: true, fallbackName: reelName() }));
$('#reelToPhotos').addEventListener('click', saveReelToPhotos);
$('#reelDownload').addEventListener('click', () => reelOut.blob && download(reelOut.blob, `${cleanName($('#stFileName').value || reelName())}.${reelOut.ext}`));
onFolderChange(() => reelOut.blob && syncReelOut());

$('#dlReel').addEventListener('click', async () => {
  const btn = $('#dlReel');
  stopPreviewTrack();
  if (!toPhotos) primeSave(); // re-grant the saved folder now, while this click still counts
  try {
    let blob = await makeReel();
    if (!blob) return;
    let ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
    // Phones: hand Photos a clean H.264/AAC MP4. Desktop: convert only WebM.
    if (state.config.features.transcode && (ext === 'webm' || toPhotos)) {
      busy(btn, true);
      toast('Preparing the MP4…', { ms: 60000 });
      try {
        const up = await uploadMedia(blob, toPhotos);
        const res = await fetch(up.path);
        if (!res.ok) throw new Error(`server said ${res.status}`);
        blob = await res.blob();
        ext = 'mp4';
      } catch (e) {
        // Keep the recording rather than failing — phones record MP4 already.
        console.warn('MP4 conversion failed:', e.message);
        if (ext === 'webm') toast(`Couldn't convert to MP4 (${e.message}) — you'll get a WebM file instead.`, { error: true, ms: 7000 });
      }
    }
    if (reelOut.url) URL.revokeObjectURL(reelOut.url);
    Object.assign(reelOut, { blob, ext, url: URL.createObjectURL(blob) });
    $('#reelOutVid').src = reelOut.url;
    $('#reelOutInfo').textContent = `· ${fmtSize(blob.size)} · ${ext.toUpperCase()}`;
    syncReelOut();
    $('#reelOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (ext === 'webm') toast('Saved as WebM — this browser cannot record MP4 and the server has no ffmpeg.');
    // Desktop with a folder already chosen → save straight away; otherwise wait for a tap.
    if (!toPhotos && folderName()) await saveReelToFolder();
    else toast(toPhotos ? 'Video ready ✓ — tap “Save to Photos”' : 'Video ready ✓ — choose where to save it', { ms: 5000 });
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
  let vgain = null;
  if (vbg) {
    await rewindVideo();
    try {
      if (vbg.sound) {
        const actx = audioContext();
        if (actx.state === 'suspended') await actx.resume();
        vgain = vbgAudio();
        vgain.connect(actx.destination);
      }
    } catch {}
    vbg.el.play().catch(() => {});
  }
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
      try { vgain?.disconnect(); } catch {}
      if (vbg) requestAnimationFrame(vloop);
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
  filter: store.get('musicFilter', 'all'),
};
const MUSIC_GROUPS = ['News tones', 'Trending reels', 'Background beds'];

async function loadCatalog() {
  try {
    music.catalog = await (await fetch('/music/catalog.json')).json();
  } catch {
    music.catalog = [];
  }
  if (music.id !== 'none' && !music.catalog.some((t) => t.id === music.id)) music.id = 'none';
  $('#musicVol').value = music.volume;
  $('#mvolOut').textContent = `${music.volume}%`;
  renderMusicFilter();
  renderTracks();
}

function trackRows() {
  const rows = [{ id: 'none', title: 'No music', mood: 'Silent reel' }, ...music.catalog];
  if (music.custom) rows.push({ id: 'custom', title: music.custom.name, mood: 'Uploaded track', file: music.custom.url });
  return rows;
}

function renderMusicFilter() {
  const groups = MUSIC_GROUPS.filter((g) => music.catalog.some((t) => (t.group || 'Background beds') === g));
  if (music.filter !== 'all' && !groups.includes(music.filter)) music.filter = 'all';
  const count = (g) => music.catalog.filter((t) => g === 'all' || (t.group || 'Background beds') === g).length;
  $('#musicFilter').innerHTML = ['all', ...groups]
    .map((g) => `<button class="chip" role="radio" data-g="${esc(g)}" aria-checked="${g === music.filter}">${g === 'all' ? 'All' : esc(g)} <span class="muted">${count(g)}</span></button>`)
    .join('');
  $$('#musicFilter .chip').forEach((c) =>
    c.addEventListener('click', () => {
      music.filter = c.dataset.g;
      store.set('musicFilter', music.filter);
      renderMusicFilter();
      renderTracks();
    }),
  );
}

function renderTracks() {
  let lastGroup = null;
  const shown = (t) => music.filter === 'all' || t.id === 'none' || t.id === 'custom' || t.id === music.id || (t.group || 'Background beds') === music.filter;
  $('#trackList').innerHTML = trackRows()
    .filter(shown)
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
    buffer = await decodeAudio(actx, data);
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
      $('#grabExt').textContent = grab.quality === 'audio' ? '.mp3' : '.mp4';
    }),
  );
  $('#grabGo').textContent = '⬇ Download MP4';
  $('#grabFileName').value = readable(i.title);
  $('#grabExt').textContent = '.mp4';
  $('#grabGo').disabled = false;
  $('#grabGo').hidden = false;
  $('#grabToCard').hidden = false;
  $('#grabToCard').disabled = false;
  grab.after = null;
  $('#grabProgress').hidden = true;
  $('#grabDone').hidden = true;
  $('#grabCaption').value = `${i.title}\n\n🎥 Credit: ${i.uploader || i.platform} (${i.platform})\n\n#news #viral #trending`;
}

$('#grabGo').addEventListener('click', async () => {
  primeSave();
  const btn = $('#grabGo');
  btn.disabled = true;
  $('#grabToCard').disabled = true;
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
    $('#grabToCard').disabled = false;
    grab.after = null;
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
  $('#grabToCard').disabled = false;
  if (j.status === 'error') {
    grab.after = null;
    $('#grabProgress').hidden = true;
    return toast(j.error || 'Download failed', { error: true, ms: 10000 });
  }
  grab.job = j;
  $('#grabProgress').hidden = true;
  $('#grabGo').hidden = true;
  $('#grabToCard').hidden = true;
  $('#grabDone').hidden = false;
  $('#grabSize').textContent = `· ${fmtSize(j.size)}`;
  const isAudio = /\.mp3$/i.test(j.file || '');
  $('#grabIgBlock').hidden = isAudio;
  grab.ext = isAudio ? 'mp3' : 'mp4';
  $('#grabToStudio').textContent = isAudio ? '✦ Make a news card from this' : '✦ Make video news card';
  if (grab.after === 'studio') {
    grab.after = null;
    if (!isAudio) return openStudio(grabItem());
  }
  // Save straight away with the chosen name (into the chosen folder if one is set).
  doSave(`/media/${encodeURIComponent(j.file)}`, 'grab', grab.ext, { fallbackName: readable(grab.info.title) });
}

$('#grabSave').addEventListener('click', () => grab.job?.file && doSave(`/media/${encodeURIComponent(grab.job.file)}`, 'grab', grab.ext || 'mp4', { fallbackName: readable(grab.info?.title) }));

function grabItem() {
  const i = grab.info;
  const file = grab.job?.file;
  const isVideo = file && !/\.mp3$/i.test(file);
  return {
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
    bgVideo: isVideo ? { src: `/media/${encodeURIComponent(file)}`, name: i.title } : null,
    published: new Date().toISOString(),
  };
}
$('#grabToStudio').addEventListener('click', () => openStudio(grabItem()));

// Before downloading: fetch the video (≤1080p), then open it straight in the studio as a video news card.
$('#grabToCard').addEventListener('click', () => {
  const i = grab.info;
  if (grab.job?.file && !/\.mp3$/i.test(grab.job.file)) return openStudio(grabItem());
  if (grab.quality === 'audio' || grab.quality === 'best') {
    const hs = i.heights || [];
    grab.quality = hs.some((h) => h >= 1080) ? '1080' : hs.some((h) => h >= 720) ? '720' : 'best';
    $$('#grabQuality .chip').forEach((x) => x.setAttribute('aria-checked', x.dataset.q === grab.quality));
    $('#grabGo').textContent = '⬇ Download MP4';
    $('#grabExt').textContent = '.mp4';
  }
  grab.after = 'studio';
  $('#grabGo').click();
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

/* ---------------- extract audio from a local video ---------------- */
const ex = { file: null, rate: '192', out: null };
const exStatus = (t) => (($('#exStatus').hidden = !t), ($('#exStatus').textContent = t || ''));
$('#exFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (!isVideoFile(f) && !/^audio\//.test(f.type)) return toast("That file isn't a video.", { error: true });
  if (f.size > 2e9) return toast('That video is over 2 GB — pick a shorter one.', { error: true });
  ex.file = f;
  ex.out = null;
  $('#exName').textContent = `${f.name} · ${fmtSize(f.size)}`;
  $('#exFileName').value = readable(f.name.replace(/\.[^.]+$/, ''));
  $('#exGo').disabled = false;
  $('#exSave').hidden = $('#exUse').hidden = $('#exPlayer').hidden = true;
  exStatus('');
});
$$('#exRate .chip').forEach((b) =>
  b.addEventListener('click', () => {
    ex.rate = b.dataset.r;
    ex.out = null;
    $$('#exRate .chip').forEach((x) => x.setAttribute('aria-checked', x === b));
  }),
);
// 1st choice: decode + encode in the browser (no upload — fast, works offline, any size the device can hold).
// Fallback: upload to the server's ffmpeg (formats the browser can't decode, e.g. some MKV/AVI).
/** decodeAudioData for old (callback) and new (promise) browsers, without an unhandled rejection. */
function decodeAudio(actx, data) {
  return new Promise((res, rej) => {
    const p = actx.decodeAudioData(data, res, rej);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });
}
const SERVER_EXTRACT_MAX = 95e6; // bigger uploads are unreliable on small hosts (free Render plan)

async function extractInBrowser(file, kbps, onProgress) {
  const actx = audioContext();
  if (!actx || typeof Worker === 'undefined') throw Object.assign(new Error('no web audio'), { decode: true });
  onProgress('Reading the video…');
  const data = await file.arrayBuffer();
  onProgress('Decoding the sound…');
  let audio;
  try {
    audio = await decodeAudio(actx, data);
  } catch (e) {
    throw Object.assign(new Error(e?.message || 'decode failed'), { decode: true });
  }
  const left = audio.getChannelData(0).slice();
  const right = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : null;
  return new Promise((resolve, reject) => {
    const w = new Worker('/js/mp3-worker.js');
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress(`Encoding MP3… ${Math.round(e.data.progress * 100)}%`);
      else {
        w.terminate();
        e.data.error ? reject(new Error(`MP3 encoding failed: ${e.data.error}`)) : resolve(e.data.done);
      }
    };
    w.onerror = (e) => (w.terminate(), reject(new Error(e.message || 'MP3 encoder failed to load')));
    onProgress('Encoding MP3…');
    w.postMessage({ left, right, sampleRate: audio.sampleRate, kbps: Number(kbps) }, [left.buffer, ...(right ? [right.buffer] : [])]);
  });
}

async function extractOnServer(file, kbps, onProgress) {
  if (!state.config.features.transcode) throw new Error("This browser couldn't read the sound, and the server has no ffmpeg.");
  if (file.size > SERVER_EXTRACT_MAX) throw new Error(`This browser couldn't read the sound in this video, and at ${fmtSize(file.size)} it's too big to send to the server. Try Chrome, or trim the video first.`);
  onProgress(`Uploading ${fmtSize(file.size)} to the server…`);
  const up = await uploadMedia(videoBlob(file), 'raw');
  onProgress('Extracting audio on the server…');
  const out = await api('/api/audio/extract', { method: 'POST', body: JSON.stringify({ name: up.name, bitrate: kbps }) });
  return await (await fetch(out.path)).blob();
}

$('#exGo').addEventListener('click', async () => {
  if (!ex.file) return;
  primeSave();
  const btn = $('#exGo');
  busy(btn, true);
  $('#exPickLabel').classList.add('is-loading');
  try {
    let blob;
    try {
      blob = await extractInBrowser(ex.file, ex.rate, exStatus);
    } catch (e) {
      if (!e.decode) throw e;
      console.warn('Browser decode failed, trying the server:', e.message);
      blob = await extractOnServer(ex.file, ex.rate, exStatus);
    }
    if (ex.out?.url) URL.revokeObjectURL(ex.out.url);
    ex.out = { blob, url: URL.createObjectURL(blob), size: blob.size };
    exStatus(`✓ MP3 ready · ${fmtSize(blob.size)} · ${ex.rate} kbps`);
    $('#exPlayer').src = ex.out.url;
    $('#exPlayer').hidden = false;
    $('#exSave').hidden = $('#exUse').hidden = false;
    await doSave(blob, 'ex', 'mp3', { fallbackName: 'newsgram audio' });
  } catch (e) {
    exStatus('');
    toast(/no sound track/i.test(e.message) ? 'This video has no sound to extract.' : e.message, { error: true, ms: 10000 });
  } finally {
    busy(btn, false);
    $('#exPickLabel').classList.remove('is-loading');
  }
});
$('#exSave').addEventListener('click', () => ex.out && doSave(ex.out.blob, 'ex', 'mp3', { fallbackName: 'newsgram audio' }));
$('#exUse').addEventListener('click', () => {
  if (!ex.out) return;
  if (music.custom?.url?.startsWith('blob:')) URL.revokeObjectURL(music.custom.url);
  music.custom = { name: ($('#exFileName').value.trim() || 'Extracted audio').slice(0, 40), url: URL.createObjectURL(ex.out.blob) };
  music.id = 'custom';
  renderTracks();
  updateMusicNote();
  toast('Added to the Music tab as “Your upload” ✓ — it plays in your next reel.');
});

// Links shared to the app (e.g. /?grab=https://…) open straight in the grabber.
function checkGrabParam() {
  const u = new URLSearchParams(location.search).get('grab');
  if (u) {
    openGrab(u);
    $('#grabForm').requestSubmit();
  }
}


/* ---------------- video editor: multi-clip timeline ---------------- */
const FRAME_SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
const ed = {
  clips: [], // { id, name, label, info:{width,height,duration,hasAudio}, in, out, crop:{top,bottom,left,right}, mode, zoom, panX, panY, volume }
  sel: null,
  frame: store.get('edFrame', '9:16'),
  t: 0,
  playing: false,
  last: 0,
  pps: 40,
  tlZoom: 1,
  videos: new Map(), // media name -> <video>
  activeEl: null,
  music: { id: store.get('edMusicId', 'none'), file: null, url: null, name: '', volume: 80, loop: true, offset: 0, in: 0, dur: 30 },
  audio: null,
  muteAll: false,
  job: null,
  timer: null,
  raf: 0,
  uid: 0,
};
const edCanvas = $('#edCanvas');
const edCtx = edCanvas.getContext('2d');
const fmtTs = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const clipLen = (c) => c.out - c.in;
const edTotal = () => ed.clips.reduce((s, c) => s + clipLen(c), 0);
function clipStarts() {
  let acc = 0;
  return ed.clips.map((c) => {
    const s = acc;
    acc += clipLen(c);
    return s;
  });
}
function clipAt(t) {
  const starts = clipStarts();
  for (let i = 0; i < ed.clips.length; i++) {
    if (t < starts[i] + clipLen(ed.clips[i]) - 1e-3 || i === ed.clips.length - 1) return { i, clip: ed.clips[i], start: starts[i], local: ed.clips[i].in + Math.max(0, t - starts[i]) };
  }
  return null;
}
const selClip = () => ed.clips.find((c) => c.id === ed.sel) || null;

/* ---------- open / add clips ---------- */
function openEditorView() {
  const active = $('.view.is-active')?.id?.replace('view-', '');
  if (active && active !== 'edit') ed.from = active;
  go('edit');
  startEdLoop();
  renderEd();
}
$('#editNav').addEventListener('click', openEditorView);
$('#edFromLink').addEventListener('click', () => {
  edPause();
  openGrab();
});

function mediaEl(name) {
  let v = ed.videos.get(name);
  if (!v) {
    v = document.createElement('video');
    v.src = `/media/${encodeURIComponent(name)}`;
    v.preload = 'auto';
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    $('#edMedia').appendChild(v);
    ed.videos.set(name, v);
  }
  return v;
}

async function addClip(name, label) {
  const info = await api('/api/video/probe', { method: 'POST', body: JSON.stringify({ name }) });
  const clip = {
    id: `c${++ed.uid}`, name, label: (label || name).slice(0, 60), info,
    in: 0, out: info.duration || 1, crop: { top: 0, bottom: 0, left: 0, right: 0 },
    mode: 'fill', zoom: 1, panX: 0, panY: 0, volume: 1,
  };
  ed.clips.push(clip);
  if (!$('#edFileName').value.trim()) $('#edFileName').value = readable(clip.label);
  mediaEl(name);
  ed.sel = clip.id;
  renderEd();
  return clip;
}

$('#edAdd').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const label = $('#edAddLabel');
  label.classList.add('is-loading');
  try {
    for (const [k, f] of files.entries()) {
      if (f.size > 300e6) {
        toast(`${f.name} is over 300 MB — skipped.`, { error: true });
        continue;
      }
      toast(`Uploading ${k + 1} of ${files.length}: ${f.name}`, { ms: 60000 });
      const up = await uploadMedia(new Blob([f], { type: f.type || 'video/mp4' }));
      await addClip(up.name, f.name.replace(/\.[^.]+$/, ''));
    }
    toast('Clips added ✓');
  } catch (err) {
    toast(err.message, { error: true, ms: 8000 });
  } finally {
    label.classList.remove('is-loading');
  }
});

// From the grabber: add the downloaded video to the timeline.
$('#grabEdit').addEventListener('click', async () => {
  if (!grab.job?.file) return;
  if (/\.mp3$/i.test(grab.job.file)) return toast('That download is audio only — pick a video quality to edit.', { error: true });
  const btn = $('#grabEdit');
  busy(btn, true);
  try {
    await addClip(grab.job.file, grab.info?.title);
    $('#edCaption').value = $('#grabCaption').value;
    openEditorView();
    toast(ed.clips.length > 1 ? `Added as clip ${ed.clips.length} ✓` : 'Added to the editor ✓');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(btn, false);
  }
});

/* ---------- frame ---------- */
function frameSize() {
  if (FRAME_SIZES[ed.frame]) return FRAME_SIZES[ed.frame];
  const c = ed.clips[0];
  if (!c) return [1080, 1920];
  const w = c.info.width * (1 - (c.crop.left + c.crop.right) / 100);
  const h = c.info.height * (1 - (c.crop.top + c.crop.bottom) / 100);
  return [w, h];
}
function sizeCanvas() {
  const [W, H] = frameSize();
  const k = 720 / Math.max(W, H);
  const cw = Math.round(W * k);
  const ch = Math.round(H * k);
  if (edCanvas.width !== cw || edCanvas.height !== ch) {
    edCanvas.width = cw;
    edCanvas.height = ch;
  }
}
$$('#edFrame .chip').forEach((b) =>
  b.addEventListener('click', () => {
    ed.frame = b.dataset.f;
    store.set('edFrame', ed.frame);
    renderEd();
  }),
);

/* ---------- drawing (mirrors the server's ffmpeg maths) ---------- */
function drawClipFrame(el, c) {
  const CW = edCanvas.width;
  const CH = edCanvas.height;
  edCtx.fillStyle = '#000';
  edCtx.fillRect(0, 0, CW, CH);
  if (!el || el.readyState < 2) return;
  const W0 = el.videoWidth || c.info.width;
  const H0 = el.videoHeight || c.info.height;
  const sx = (W0 * c.crop.left) / 100;
  const sy = (H0 * c.crop.top) / 100;
  const sw = W0 * (1 - (c.crop.left + c.crop.right) / 100);
  const sh = H0 * (1 - (c.crop.top + c.crop.bottom) / 100);
  if (sw < 2 || sh < 2) return;
  if (c.mode === 'fit') {
    const cover = Math.max(CW / sw, CH / sh);
    edCtx.save();
    edCtx.filter = 'blur(18px) brightness(0.78)';
    edCtx.drawImage(el, sx, sy, sw, sh, (CW - sw * cover) / 2, (CH - sh * cover) / 2, sw * cover, sh * cover);
    edCtx.restore();
    const fit = Math.min(CW / sw, CH / sh);
    edCtx.drawImage(el, sx, sy, sw, sh, (CW - sw * fit) / 2, (CH - sh * fit) / 2, sw * fit, sh * fit);
  } else {
    const s = Math.max(CW / sw, CH / sh) * c.zoom;
    const dw = sw * s;
    const dh = sh * s;
    const x = -(dw - CW) * (0.5 + c.panX);
    const y = -(dh - CH) * (0.5 + c.panY);
    edCtx.drawImage(el, sx, sy, sw, sh, x, y, dw, dh);
  }
}

/* ---------- playback engine ---------- */
function musicUrl() {
  if (ed.music.id === 'none') return null;
  if (ed.music.id === 'custom') return ed.music.url;
  return music.catalog.find((t) => t.id === ed.music.id)?.file || null;
}
function syncMusic() {
  const url = musicUrl();
  if (!url) {
    if (ed.audio) ed.audio.pause();
    return;
  }
  if (!ed.audio || ed.audio.dataset.src !== url) {
    ed.audio?.pause();
    ed.audio = new Audio(url);
    ed.audio.dataset.src = url;
    ed.audio.preload = 'auto';
    ed.audio.addEventListener('loadedmetadata', () => {
      ed.music.dur = ed.audio.duration || ed.music.dur;
      $('#edMin').max = Math.max(0, Math.floor(ed.music.dur - 1));
      renderTimeline();
    });
  }
  const a = ed.audio;
  a.volume = Math.min(1, ed.music.volume / 100);
  if (!ed.playing) return a.paused || a.pause();
  const rel = ed.t - ed.music.offset;
  const first = Math.max(0.1, ed.music.dur - ed.music.in);
  let pos = null;
  if (rel >= 0) {
    if (rel < first) pos = ed.music.in + rel;
    else if (ed.music.loop) pos = (rel - first) % ed.music.dur;
  }
  if (pos == null) return a.paused || a.pause();
  if (a.paused) {
    a.currentTime = pos;
    a.play().catch(() => {});
  } else if (Math.abs(a.currentTime - pos) > 0.35) a.currentTime = pos;
}

function edTick(now) {
  ed.raf = requestAnimationFrame(edTick);
  if (!$('#view-edit').classList.contains('is-active')) return;
  const total = edTotal();
  if (ed.playing) {
    ed.t += (now - (ed.last || now)) / 1000;
    if (ed.t >= total) {
      ed.t = total;
      edPause();
    }
  }
  ed.last = now;
  const at = clipAt(Math.min(ed.t, Math.max(0, total - 0.001)));
  if (at) {
    const el = mediaEl(at.clip.name);
    if (ed.activeEl && ed.activeEl !== el) ed.activeEl.pause();
    ed.activeEl = el;
    const vol = ed.muteAll ? 0 : Math.min(1, at.clip.volume);
    el.volume = vol;
    el.muted = vol === 0;
    if (ed.playing) {
      if (el.paused) {
        el.currentTime = at.local;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - at.local) > 0.3) el.currentTime = at.local;
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - at.local) > 0.04) el.currentTime = at.local;
    }
    drawClipFrame(el, at.clip);
  } else {
    edCtx.fillStyle = '#000';
    edCtx.fillRect(0, 0, edCanvas.width, edCanvas.height);
  }
  syncMusic();
  $('#edTime').textContent = `${fmtTs(ed.t)} / ${fmtTs(total)}`;
  $('#tlPlayhead').style.left = `${ed.t * ed.pps}px`;
  if (ed.playing) keepPlayheadVisible();
}
function startEdLoop() {
  if (!ed.raf) ed.raf = requestAnimationFrame(edTick);
}
function edPlay() {
  if (!ed.clips.length) return;
  if (ed.t >= edTotal() - 0.05) ed.t = 0;
  ed.playing = true;
  ed.last = performance.now();
  $('#edPlay').textContent = '❚❚';
  $('#edPlay').setAttribute('aria-label', 'Pause');
}
function edPause() {
  ed.playing = false;
  ed.activeEl?.pause();
  ed.audio?.pause();
  $('#edPlay').textContent = '▶';
  $('#edPlay').setAttribute('aria-label', 'Play');
}
function edSeek(t) {
  ed.t = Math.max(0, Math.min(edTotal(), t));
}
$('#edPlay').addEventListener('click', () => (ed.playing ? edPause() : edPlay()));
$('#edToStart').addEventListener('click', () => edSeek(0));
function keepPlayheadVisible() {
  const sc = $('#tlScroll');
  const x = ed.t * ed.pps;
  if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.3);
}

/* ---------- timeline ---------- */
function renderTimeline() {
  const sc = $('#tlScroll');
  const total = edTotal();
  const avail = Math.max(200, sc.clientWidth - 40);
  ed.pps = Math.max(8, (avail / Math.max(total, 5)) * ed.tlZoom);
  const width = Math.max(sc.clientWidth, total * ed.pps + 60);
  $('#tlInner').style.width = `${width}px`;

  // ruler
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => s * ed.pps >= 64) || 300;
  let html = '';
  for (let t = 0; t * ed.pps < width; t += step) {
    html += `<span class="tl-tick" style="left:${t * ed.pps}px">${fmtDur(t) || '0:00'}</span>`;
    const half = t + step / 2;
    if (step >= 1) html += `<span class="tl-tick minor" style="left:${half * ed.pps}px"></span>`;
  }
  $('#tlRuler').innerHTML = html;

  // video clips
  const starts = clipStarts();
  $('#tlVideo').innerHTML = ed.clips
    .map((c, i) => {
      const w = clipLen(c) * ed.pps;
      const stripW = (c.info.duration || clipLen(c)) * ed.pps;
      return `<div class="tl-clip ${c.id === ed.sel ? 'sel' : ''}" data-id="${c.id}" style="left:${starts[i] * ed.pps}px;width:${w}px;background-image:url('/api/video/thumbs/${encodeURIComponent(c.name)}');background-size:${stripW}px 100%;background-position:${-c.in * ed.pps}px 0">
        <span class="tl-h l" data-h="l"></span><span class="lbl">${i + 1} · ${esc(c.label)} · ${clipLen(c).toFixed(1)}s</span><span class="tl-h r" data-h="r"></span>
      </div>`;
    })
    .join('');

  // music bar
  const m = ed.music;
  if (m.id !== 'none' && total > 0) {
    const first = Math.max(0.1, m.dur - m.in);
    const len = Math.min(total - m.offset, m.loop ? Infinity : first);
    const name = m.id === 'custom' ? m.name : music.catalog.find((t) => t.id === m.id)?.title || 'Music';
    let marks = '';
    if (m.loop) for (let x = first; x < len; x += m.dur) marks += `<span class="loopmark" style="left:${x * ed.pps}px"></span>`;
    $('#tlMusic').innerHTML = `<div class="tl-music" id="tlMusicBar" style="left:${m.offset * ed.pps}px;width:${Math.max(4, len * ed.pps)}px">♪ ${esc(name)}${m.loop ? ' · repeats' : ''}${marks}</div>`;
  } else {
    $('#tlMusic').innerHTML = `<span class="muted small" style="position:absolute;left:10px;top:13px">${total ? 'No music — pick a track in the Music tab' : ''}</span>`;
  }
  $('#tlPlayhead').style.left = `${ed.t * ed.pps}px`;
}

// Clip interactions: trim handles, drag to reorder, click to select/seek.
$('#tlVideo').addEventListener('pointerdown', (e) => {
  const block = e.target.closest('.tl-clip');
  if (!block) return;
  e.preventDefault();
  edPause();
  const clip = ed.clips.find((c) => c.id === block.dataset.id);
  const handle = e.target.dataset.h;
  const x0 = e.clientX;
  const start = { in: clip.in, out: clip.out };
  const idx0 = ed.clips.indexOf(clip);
  let moved = false;
  ed.sel = clip.id;
  const onMove = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 5) return;
    moved = true;
    const d = dx / ed.pps;
    if (handle === 'l') {
      clip.in = Math.max(0, Math.min(start.out - 0.3, start.in + d));
      edSeek(clipStarts()[ed.clips.indexOf(clip)]);
      renderTimeline();
    } else if (handle === 'r') {
      clip.out = Math.min(clip.info.duration || start.out, Math.max(start.in + 0.3, start.out + d));
      edSeek(clipStarts()[ed.clips.indexOf(clip)] + clipLen(clip) - 0.05);
      renderTimeline();
    } else {
      const el = $(`.tl-clip[data-id="${clip.id}"]`);
      el.classList.add('drag');
      el.style.transform = `translateX(${dx}px)`;
    }
  };
  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    if (!moved) {
      const r = $('#tlInner').getBoundingClientRect();
      edSeek((ev.clientX - r.left) / ed.pps);
    } else if (!handle) {
      // drop position → new index
      const r = $('#tlInner').getBoundingClientRect();
      const tDrop = (ev.clientX - r.left) / ed.pps;
      const others = ed.clips.filter((c) => c !== clip);
      let acc = 0;
      let idx = others.length;
      for (let i = 0; i < others.length; i++) {
        if (tDrop < acc + clipLen(others[i]) / 2) {
          idx = i;
          break;
        }
        acc += clipLen(others[i]);
      }
      others.splice(idx, 0, clip);
      ed.clips = others;
      if (idx !== idx0) toast(`Moved to position ${idx + 1}`);
      edSeek(clipStarts()[ed.clips.indexOf(clip)]);
    }
    renderEd();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  renderClipPanel();
  highlightSel();
});

// Music bar: drag to change where the music starts in the video.
$('#tlMusic').addEventListener('pointerdown', (e) => {
  const bar = e.target.closest('.tl-music');
  if (!bar) return;
  e.preventDefault();
  edPause();
  bar.classList.add('drag');
  const x0 = e.clientX;
  const o0 = ed.music.offset;
  const onMove = (ev) => {
    ed.music.offset = Math.max(0, Math.min(Math.max(0, edTotal() - 0.5), o0 + (ev.clientX - x0) / ed.pps));
    bar.style.left = `${ed.music.offset * ed.pps}px`;
    syncMusicPanel();
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    renderTimeline();
    showEdTab('music');
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

// Ruler click + playhead handle drag = scrub.
function scrubFrom(e) {
  e.preventDefault();
  edPause();
  const r = $('#tlInner').getBoundingClientRect();
  const move = (ev) => edSeek((ev.clientX - r.left) / ed.pps);
  move(e);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
$('#tlRuler').addEventListener('pointerdown', scrubFrom);
$('#tlHandle').addEventListener('pointerdown', scrubFrom);
$('#edTlZoom').addEventListener('input', (e) => {
  ed.tlZoom = Number(e.target.value);
  renderTimeline();
  keepPlayheadVisible();
});
window.addEventListener('resize', () => $('#view-edit').classList.contains('is-active') && renderTimeline());

/* ---------- edit actions ---------- */
function splitAtPlayhead() {
  const at = clipAt(ed.t);
  if (!at) return;
  const c = at.clip;
  if (at.local - c.in < 0.2 || c.out - at.local < 0.2) return toast('Move the playhead inside a clip to split it.');
  const b = { ...c, id: `c${++ed.uid}`, crop: { ...c.crop }, in: at.local };
  c.out = at.local;
  ed.clips.splice(at.i + 1, 0, b);
  ed.sel = b.id;
  renderEd();
}
function deleteSelected() {
  const c = selClip();
  if (!c) return toast('Select a clip first.');
  ed.clips = ed.clips.filter((x) => x !== c);
  ed.sel = ed.clips[0]?.id || null;
  edSeek(Math.min(ed.t, edTotal()));
  renderEd();
}
$('#edSplit').addEventListener('click', splitAtPlayhead);
$('#edDel').addEventListener('click', deleteSelected);
$('#edDup').addEventListener('click', () => {
  const c = selClip();
  if (!c) return toast('Select a clip first.');
  const i = ed.clips.indexOf(c);
  const d = { ...c, id: `c${++ed.uid}`, crop: { ...c.crop } };
  ed.clips.splice(i + 1, 0, d);
  ed.sel = d.id;
  renderEd();
});
document.addEventListener('keydown', (e) => {
  if (!$('#view-edit').classList.contains('is-active')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  if (e.code === 'Space') {
    e.preventDefault();
    ed.playing ? edPause() : edPlay();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (document.activeElement?.type === 'range') return;
    e.preventDefault();
    edPause();
    edSeek(ed.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30));
  } else if (e.key === 's' || e.key === 'S') splitAtPlayhead();
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  }
});

/* ---------- pan the selected clip by dragging the preview ---------- */
{
  let drag = null;
  edCanvas.addEventListener('pointerdown', (e) => {
    const at = clipAt(ed.t);
    if (!at || at.clip.mode !== 'fill') return;
    ed.sel = at.clip.id;
    renderClipPanel();
    highlightSel();
    edCanvas.setPointerCapture(e.pointerId);
    edCanvas.classList.add('dragging');
    drag = { x: e.clientX, y: e.clientY, c: at.clip, px: at.clip.panX, py: at.clip.panY };
  });
  edCanvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = drag.c;
    const rect = edCanvas.getBoundingClientRect();
    const k = edCanvas.width / rect.width;
    const sw = c.info.width * (1 - (c.crop.left + c.crop.right) / 100);
    const sh = c.info.height * (1 - (c.crop.top + c.crop.bottom) / 100);
    const s = Math.max(edCanvas.width / sw, edCanvas.height / sh) * c.zoom;
    const spareX = sw * s - edCanvas.width;
    const spareY = sh * s - edCanvas.height;
    if (spareX > 1) c.panX = Math.max(-0.5, Math.min(0.5, drag.px - ((e.clientX - drag.x) * k) / spareX));
    if (spareY > 1) c.panY = Math.max(-0.5, Math.min(0.5, drag.py - ((e.clientY - drag.y) * k) / spareY));
  });
  const end = () => {
    drag = null;
    edCanvas.classList.remove('dragging');
  };
  edCanvas.addEventListener('pointerup', end);
  edCanvas.addEventListener('pointercancel', end);
}

/* ---------- side panels ---------- */
function showEdTab(name) {
  $$('.ed-tabs .tab').forEach((t) => t.classList.toggle('is-active', t.dataset.ep === name));
  $$('.ed-side .ipanel').forEach((p) => p.classList.toggle('is-active', p.dataset.ep === name));
  if (name === 'export') renderSummary();
}
$$('.ed-tabs .tab').forEach((t) => t.addEventListener('click', () => showEdTab(t.dataset.ep)));

function highlightSel() {
  $$('#tlVideo .tl-clip').forEach((b) => b.classList.toggle('sel', b.dataset.id === ed.sel));
}

const EDGE = { top: 'edCt', bottom: 'edCb', left: 'edCl', right: 'edCr' };
function renderClipPanel() {
  const c = selClip();
  $('#edNoClip').hidden = Boolean(c);
  $('#edClipPanel').hidden = !c;
  if (!c) return;
  $('#edClipName').textContent = c.label;
  $('#edClipTimes').textContent = `${fmtTs(c.in)} → ${fmtTs(c.out)} · ${clipLen(c).toFixed(1)}s`;
  $$('#edMode .chip').forEach((b) => b.setAttribute('aria-checked', b.dataset.m === c.mode));
  $('#edZoomField').hidden = c.mode !== 'fill';
  $('#edPanHint').hidden = c.mode !== 'fill';
  $('#edZoom').value = Math.round(c.zoom * 100);
  $('#edZoomOut').textContent = `${Math.round(c.zoom * 100)}%`;
  for (const [k, id] of Object.entries(EDGE)) {
    $(`#${id}`).value = c.crop[k];
    $(`#${id}Out`).textContent = `${Math.round(c.crop[k])}%`;
  }
  $('#edCvol').value = Math.round(c.volume * 100);
  $('#edCvol').disabled = !c.info.hasAudio;
  $('#edCvolOut').textContent = c.info.hasAudio ? `${Math.round(c.volume * 100)}%` : 'no sound';
}
$$('#edMode .chip').forEach((b) =>
  b.addEventListener('click', () => {
    const c = selClip();
    if (!c) return;
    c.mode = b.dataset.m;
    renderClipPanel();
  }),
);
$('#edZoom').addEventListener('input', (e) => {
  const c = selClip();
  if (!c) return;
  c.zoom = Number(e.target.value) / 100;
  $('#edZoomOut').textContent = `${e.target.value}%`;
});
for (const [k, id] of Object.entries(EDGE)) {
  $(`#${id}`).addEventListener('input', (e) => {
    const c = selClip();
    if (!c) return;
    const other = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[k];
    c.crop[k] = Math.min(Number(e.target.value), 90 - c.crop[other]);
    $(`#${id}Out`).textContent = `${Math.round(c.crop[k])}%`;
    if (ed.frame === 'original' && c === ed.clips[0]) sizeCanvas();
  });
}
$('#edCvol').addEventListener('input', (e) => {
  const c = selClip();
  if (!c) return;
  c.volume = Number(e.target.value) / 100;
  $('#edCvolOut').textContent = `${e.target.value}%`;
});
$('#edResetClip').addEventListener('click', () => {
  const c = selClip();
  if (!c) return;
  Object.assign(c, { crop: { top: 0, bottom: 0, left: 0, right: 0 }, mode: 'fill', zoom: 1, panX: 0, panY: 0 });
  renderClipPanel();
  sizeCanvas();
});
$('#edApplyAll').addEventListener('click', () => {
  const c = selClip();
  if (!c) return;
  for (const x of ed.clips) Object.assign(x, { crop: { ...c.crop }, mode: c.mode, zoom: c.zoom, panX: c.panX, panY: c.panY });
  toast(`Framing applied to ${ed.clips.length} clip${ed.clips.length > 1 ? 's' : ''} ✓`);
});

/* music panel */
function renderEdMusicSelect() {
  const groups = {};
  for (const t of music.catalog) (groups[t.group || 'Background beds'] ||= []).push(t);
  $('#edMusic').innerHTML =
    `<option value="none">No music</option>` +
    Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((t) => `<option value="${t.id}">${esc(t.title)} — ${esc(t.mood)}</option>`).join('')}</optgroup>`).join('') +
    (ed.music.file ? `<option value="custom">Your track: ${esc(ed.music.name)}</option>` : '');
  if (ed.music.id !== 'none' && ed.music.id !== 'custom' && !music.catalog.some((t) => t.id === ed.music.id)) ed.music.id = 'none';
  $('#edMusic').value = ed.music.id;
}
function syncMusicPanel() {
  const m = ed.music;
  $('#edLoop').checked = m.loop;
  $('#edMvol').value = m.volume;
  $('#edMvolOut').textContent = `${m.volume}%`;
  $('#edMin').value = m.in;
  $('#edMinOut').textContent = fmtDur(m.in) || '0:00';
  $('#edMoff').max = Math.max(0.1, edTotal() - 0.5).toFixed(1);
  $('#edMoff').value = m.offset;
  $('#edMoffOut').textContent = fmtTs(m.offset);
  $('#edMuteAll').checked = ed.muteAll;
}
$('#edMusic').addEventListener('change', (e) => {
  ed.music.id = e.target.value;
  if (ed.music.id !== 'custom') {
    store.set('edMusicId', ed.music.id);
    const t = music.catalog.find((x) => x.id === ed.music.id);
    ed.music.dur = t?.duration || 30;
  }
  ed.music.in = 0;
  $('#edMin').max = Math.max(0, Math.floor(ed.music.dur - 1));
  syncMusicPanel();
  renderTimeline();
});
$('#edMusicUpload').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 40e6) return toast('Pick a track under 40 MB.', { error: true });
  try {
    toast('Uploading your track…');
    const up = await uploadMedia(new Blob([f], { type: f.type || 'audio/mpeg' }));
    if (ed.music.url?.startsWith('blob:')) URL.revokeObjectURL(ed.music.url);
    Object.assign(ed.music, { id: 'custom', file: up.name, url: URL.createObjectURL(f), name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), in: 0 });
    const probeA = new Audio(ed.music.url);
    probeA.addEventListener('loadedmetadata', () => {
      ed.music.dur = probeA.duration || 30;
      $('#edMin').max = Math.max(0, Math.floor(ed.music.dur - 1));
      renderTimeline();
    });
    renderEdMusicSelect();
    syncMusicPanel();
    renderTimeline();
    toast('Track added ✓');
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('#edLoop').addEventListener('change', (e) => {
  ed.music.loop = e.target.checked;
  renderTimeline();
});
$('#edMvol').addEventListener('input', (e) => {
  ed.music.volume = Number(e.target.value);
  $('#edMvolOut').textContent = `${ed.music.volume}%`;
});
$('#edMin').addEventListener('input', (e) => {
  ed.music.in = Number(e.target.value);
  $('#edMinOut').textContent = fmtDur(ed.music.in) || '0:00';
  renderTimeline();
});
$('#edMoff').addEventListener('input', (e) => {
  ed.music.offset = Number(e.target.value);
  $('#edMoffOut').textContent = fmtTs(ed.music.offset);
  renderTimeline();
});
$('#edMuteAll').addEventListener('change', (e) => (ed.muteAll = e.target.checked));

/* ---------- export ---------- */
function renderSummary() {
  const [W, H] = FRAME_SIZES[ed.frame] || frameSize().map((v) => Math.round(v));
  const m = ed.music.id === 'none' ? 'no music' : `music: ${ed.music.id === 'custom' ? ed.music.name : music.catalog.find((t) => t.id === ed.music.id)?.title}${ed.music.loop ? ' (repeats)' : ''}`;
  $('#edSummary').textContent = ed.clips.length
    ? `${ed.clips.length} clip${ed.clips.length > 1 ? 's' : ''} · ${edTotal().toFixed(1)}s · ${ed.frame === 'original' ? 'original shape' : `${W}×${H}`} · ${m}`
    : 'Add clips first.';
  $('#edRender').disabled = !ed.clips.length;
}
$('#edRender').addEventListener('click', async () => {
  primeSave();
  if (!ed.clips.length) return;
  edPause();
  const btn = $('#edRender');
  btn.disabled = true;
  $('#edDone').hidden = true;
  $('#edProgress').hidden = false;
  $('#edBar').style.width = '2%';
  $('#edStage').textContent = 'Rendering…';
  try {
    const body = {
      frame: ed.frame,
      muteAll: ed.muteAll,
      clips: ed.clips.map((c) => ({ name: c.name, in: c.in, out: c.out, crop: c.crop, mode: c.mode, zoom: c.zoom, panX: c.panX, panY: c.panY, volume: c.volume })),
      music: ed.music.id === 'none' ? null : { id: ed.music.id, file: ed.music.file, volume: ed.music.volume / 100, loop: ed.music.loop, offset: ed.music.offset, in: ed.music.in },
    };
    const { id } = await api('/api/video/render', { method: 'POST', body: JSON.stringify(body) });
    clearInterval(ed.timer);
    ed.timer = setInterval(() => pollRender(id), 900);
  } catch (e) {
    toast(e.message, { error: true, ms: 9000 });
    btn.disabled = false;
    $('#edProgress').hidden = true;
  }
});
async function pollRender(id) {
  let j;
  try {
    j = await api(`/api/video/edit/${id}`);
  } catch (e) {
    clearInterval(ed.timer);
    $('#edRender').disabled = false;
    return toast(e.message, { error: true });
  }
  $('#edBar').style.width = `${Math.max(2, j.progress)}%`;
  $('#edStage').textContent = `Rendering… ${Math.round(j.progress)}%`;
  if (j.status === 'running') return;
  clearInterval(ed.timer);
  $('#edRender').disabled = false;
  $('#edProgress').hidden = true;
  if (j.status === 'error') return toast(j.error, { error: true, ms: 10000 });
  ed.job = j;
  $('#edDone').hidden = false;
  $('#edInfo').textContent = `· ${j.width}×${j.height} · ${j.duration.toFixed(1)}s · ${fmtSize(j.size)}`;
  if (!$('#edFileName').value.trim()) $('#edFileName').value = readable(ed.clips[0]?.label || 'newsgram video');
  // A folder is set → save straight away.
  if (folderName()) doSave(`/media/${encodeURIComponent(j.file)}`, 'ed', 'mp4', { fallbackName: 'newsgram video' });
  if (!$('#edCaption').value) $('#edCaption').value = `${ed.clips[0]?.label || ''}\n\n#news #viral #trending`;
  toast('Video ready ✓');
}
$('#edSave').addEventListener('click', () => ed.job?.file && doSave(`/media/${encodeURIComponent(ed.job.file)}`, 'ed', 'mp4', { fallbackName: 'newsgram video' }));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-saveas]');
  if (!b) return;
  const key = b.dataset.saveas;
  if (key === 'ed' && ed.job?.file) doSave(`/media/${encodeURIComponent(ed.job.file)}`, 'ed', 'mp4', { askWhere: true });
  if (key === 'grab' && grab.job?.file) doSave(`/media/${encodeURIComponent(grab.job.file)}`, 'grab', grab.ext || 'mp4', { askWhere: true });
});
$('#edWatch').addEventListener('click', () => ed.job?.file && window.open(`/media/${encodeURIComponent(ed.job.file)}`, '_blank'));
$('#edIg').addEventListener('click', async () => {
  if (!state.config.features.instagram) return $('#igSetup').showModal();
  const caption = $('#edCaption').value.trim();
  if (!caption) return toast('Add a caption first.', { error: true });
  const btn = $('#edIg');
  busy(btn, true);
  toast('Posting to Instagram… this can take a minute.', { ms: 90000 });
  try {
    const out = await api('/api/instagram/publish', { method: 'POST', body: JSON.stringify({ name: ed.job.file, kind: 'video', caption }) });
    toast(out.permalink ? `Posted! <a href="${esc(out.permalink)}" target="_blank" rel="noopener">View on Instagram ↗</a>` : 'Posted to Instagram!', { html: true, ms: 8000 });
  } catch (e) {
    toast(`Instagram: ${e.message}`, { error: true, ms: 9000 });
  } finally {
    busy(btn, false);
  }
});

function renderEd() {
  $$('#edFrame .chip').forEach((b) => b.setAttribute('aria-checked', b.dataset.f === ed.frame));
  $('#edEmpty').hidden = ed.clips.length > 0;
  sizeCanvas();
  edSeek(ed.t);
  renderTimeline();
  renderClipPanel();
  if (!$('#edMusic').options.length || $('#edMusic').options.length < 2) renderEdMusicSelect();
  syncMusicPanel();
  renderSummary();
}

/* ---------------- boot ---------------- */
/* ---------------- audio editor: join several audio files into one ---------------- */
const au = {
  clips: [], // { id, name, buffer, in, out, vol, fi, fo, peaks }
  sel: null,
  uid: 0,
  t: 0,
  playing: null, // { t0, ctxT0, nodes, stopAt, only }
  raf: 0,
  zoom: 1,
  fmt: store.get('auFmt', 'mp3'),
  rate: store.get('auRate', '192'),
  out: null, // { blob, ext, url, photos }
};
const PEAKS_PER_SEC = 60;
const auLen = (c) => c.out - c.in;
const auTotal = () => au.clips.reduce((s, c) => s + auLen(c), 0);
const auSel = () => au.clips.find((c) => c.id === au.sel) || null;
const auStarts = () => {
  let acc = 0;
  return au.clips.map((c) => ((acc += auLen(c)), acc - auLen(c)));
};
const fmtT = (t) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

function peaksOf(buffer) {
  const n = Math.max(1, Math.ceil(buffer.duration * PEAKS_PER_SEC));
  const step = buffer.length / n;
  const chans = [...Array(Math.min(2, buffer.numberOfChannels)).keys()].map((i) => buffer.getChannelData(i));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = Math.floor(i * step);
    const b = Math.min(buffer.length, Math.floor((i + 1) * step));
    for (const d of chans) for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(d[j]));
    peaks[i] = m;
  }
  return peaks;
}

async function auDecode(file) {
  const actx = audioContext();
  if (!actx) throw new Error('This browser has no Web Audio support.');
  try {
    return await decodeAudio(actx, await file.arrayBuffer());
  } catch {
    // Formats the browser can't read (e.g. some MKV/AVI/AMR): let the server's ffmpeg convert it.
    const mp3 = await extractOnServer(file, '320', (m) => toast(`${file.name}: ${m}`, { ms: 30000 }));
    return await decodeAudio(actx, await mp3.arrayBuffer());
  }
}

async function auAddFiles(files) {
  files = [...files].filter(Boolean);
  if (!files.length) return;
  $('#auAddLabel').classList.add('is-loading');
  let added = 0;
  for (const [k, f] of files.entries()) {
    if (!/^audio\//.test(f.type) && !isVideoFile(f) && !/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|amr|wma|aiff?)$/i.test(f.name)) {
      toast(`${f.name} isn't an audio file — skipped.`, { error: true });
      continue;
    }
    if (f.size > 1e9) {
      toast(`${f.name} is over 1 GB — skipped.`, { error: true });
      continue;
    }
    toast(`Loading ${k + 1} of ${files.length}: ${f.name}`, { ms: 30000 });
    try {
      const buffer = await auDecode(f);
      const clip = { id: `a${++au.uid}`, name: f.name.replace(/\.[^.]+$/, '').slice(0, 60), buffer, in: 0, out: buffer.duration, vol: 1, fi: 0, fo: 0, peaks: peaksOf(buffer) };
      au.clips.push(clip);
      au.sel = clip.id;
      added++;
      if (!$('#auFileName').value.trim()) $('#auFileName').value = readable(clip.name);
      auRender();
    } catch (e) {
      toast(`Couldn't read ${f.name}: ${e.message}`, { error: true, ms: 9000 });
    }
  }
  $('#auAddLabel').classList.remove('is-loading');
  if (added) toast(added > 1 ? `${added} files added ✓` : 'Added ✓');
}

$('#auAdd').addEventListener('change', (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  auAddFiles(files);
});
const auDrop = $('#auDrop');
auDrop.addEventListener('click', () => $('#auAdd').click());
auDrop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('#auAdd').click()));
auDrop.addEventListener('dragover', (e) => (e.preventDefault(), auDrop.classList.add('is-over')));
auDrop.addEventListener('dragleave', () => auDrop.classList.remove('is-over'));
auDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  auDrop.classList.remove('is-over');
  auAddFiles(e.dataTransfer.files || []);
});
$('#audioNav').addEventListener('click', () => go('audio'));

/* ---------- timeline ---------- */
function auPps() {
  const w = $('#auScroll').clientWidth || 600;
  return (Math.max(10, auTotal()) > 0 ? (w - 24) / Math.max(10, auTotal()) : 40) * au.zoom;
}

function drawWave(cv, clip, wpx) {
  const h = 84;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(wpx * dpr));
  cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = 'rgba(198,255,61,0.85)';
  const a = clip.in * PEAKS_PER_SEC;
  const b = clip.out * PEAKS_PER_SEC;
  const per = (b - a) / wpx;
  const mid = h / 2 + 6;
  if (!clip.peakMax) {
    let m = 0.05; // loop, not spread: Safari limits argument counts
    for (let i = 0; i < clip.peaks.length; i++) if (clip.peaks[i] > m) m = clip.peaks[i];
    clip.peakMax = m;
  }
  const norm = 0.92 / clip.peakMax;
  for (let x = 0; x < wpx; x += 2) {
    let m = 0;
    for (let i = Math.floor(a + x * per); i < Math.min(clip.peaks.length, Math.floor(a + (x + 2) * per) + 1); i++) m = Math.max(m, clip.peaks[i]);
    const y = Math.max(1, Math.min(1, m * norm * clip.vol) * (h / 2 - 12));
    g.fillRect(x, mid - y, 1.4, y * 2);
  }
}

function auRender() {
  const total = auTotal();
  const pps = auPps();
  const wrap = $('.au');
  wrap.classList.toggle('has-clips', au.clips.length > 0);
  $('#auInner').style.width = `${Math.max($('#auScroll').clientWidth, total * pps + 40)}px`;
  // ruler
  const step = pps > 120 ? 1 : pps > 40 ? 5 : pps > 15 ? 10 : pps > 5 ? 30 : 60;
  let ticks = '';
  for (let t = 0; t <= Math.max(total, 10) + step; t += step) ticks += `<span class="tl-tick" style="left:${t * pps}px">${fmtDur(t) || '0:00'}</span>`;
  $('#auRuler').innerHTML = ticks;
  // clips
  const starts = auStarts();
  $('#auTrack').innerHTML = au.clips
    .map((c, i) => {
      const w = auLen(c) * pps;
      return `<div class="tl-clip ${c.id === au.sel ? 'sel' : ''}" data-id="${c.id}" style="left:${starts[i] * pps}px;width:${Math.max(6, w - 2)}px">
        <canvas></canvas>
        ${c.fi ? `<span class="fade in" style="width:${c.fi * pps}px"></span>` : ''}${c.fo ? `<span class="fade out" style="width:${c.fo * pps}px"></span>` : ''}
        <span class="lbl">${esc(c.name)} · ${fmtDur(auLen(c)) || '0:00'}</span>
        <span class="tl-h l" data-h="l"></span><span class="tl-h r" data-h="r"></span>
      </div>`;
    })
    .join('');
  $$('#auTrack .tl-clip').forEach((el) => {
    const c = au.clips.find((x) => x.id === el.dataset.id);
    drawWave($('canvas', el), c, Math.max(6, auLen(c) * pps - 2));
  });
  auPlayhead();
  auPanel();
}

/** Live update while dragging a crop edge (keeps the DOM, so the pointer isn't lost). */
function auLayout(active) {
  const pps = auPps();
  const starts = auStarts();
  au.clips.forEach((c, i) => {
    const el = $(`#auTrack .tl-clip[data-id="${c.id}"]`);
    if (!el) return;
    el.style.left = `${starts[i] * pps}px`;
    el.style.width = `${Math.max(6, auLen(c) * pps - 2)}px`;
    if (c === active) {
      drawWave($('canvas', el), c, Math.max(6, auLen(c) * pps - 2));
      $('.lbl', el).textContent = `${c.name} · ${fmtDur(auLen(c)) || '0:00'}`;
    }
  });
  $('#auTime').textContent = `${fmtT(au.t)} / ${fmtT(auTotal())}`;
  if (active === auSel()) $('#auClipTimes').textContent = `${fmtT(active.in)} → ${fmtT(active.out)} of ${fmtT(active.buffer.duration)}`;
}

function auPlayhead() {
  const total = auTotal();
  $('#auPlayhead').style.left = `${au.t * auPps()}px`;
  $('#auTime').textContent = `${fmtT(au.t)} / ${fmtT(total)}`;
  $('#auPlay').textContent = au.playing ? '❚❚' : '▶';
  $('#auPlay').setAttribute('aria-label', au.playing ? 'Pause' : 'Play');
}

function auPanel() {
  const c = auSel();
  $('#auNoClip').hidden = !!c;
  $('#auClipPanel').hidden = !c;
  const total = auTotal();
  $('#auExport').disabled = !au.clips.length;
  $('#auSummary').textContent = au.clips.length ? `${au.clips.length} clip${au.clips.length > 1 ? 's' : ''} · ${fmtDur(total) || '0:00'} in total → one ${au.fmt.toUpperCase()} file` : 'No audio yet — add files first.';
  if (!c) return;
  $('#auClipName').textContent = c.name;
  $('#auClipTimes').textContent = `${fmtT(c.in)} → ${fmtT(c.out)} of ${fmtT(c.buffer.duration)}`;
  $('#auIn').value = c.in.toFixed(1);
  $('#auIn').max = c.buffer.duration.toFixed(1);
  $('#auOut').value = c.out.toFixed(1);
  $('#auOut').max = c.buffer.duration.toFixed(1);
  $('#auVol').value = Math.round(c.vol * 100);
  $('#auVolOut').textContent = `${Math.round(c.vol * 100)}%`;
  $('#auFi').value = c.fi;
  $('#auFiOut').textContent = `${c.fi}s`;
  $('#auFo').value = c.fo;
  $('#auFoOut').textContent = `${c.fo}s`;
  const i = au.clips.indexOf(c);
  $('#auLeft').disabled = i === 0;
  $('#auRight').disabled = i === au.clips.length - 1;
}

function auEdited() {
  au.out = null;
  $('#auOutBox').hidden = true;
  au.t = Math.min(au.t, auTotal());
  auRender();
}

/* pointer: select, reorder, crop edges, seek */
const auTrack = $('#auTrack');
auTrack.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tl-clip');
  if (!el) return auSeekFrom(e);
  e.preventDefault();
  const c = au.clips.find((x) => x.id === el.dataset.id);
  au.sel = c.id;
  const h = e.target.closest('[data-h]')?.dataset.h;
  const pps = auPps();
  const x0 = e.clientX;
  const start = { in: c.in, out: c.out };
  const idx0 = au.clips.indexOf(c);
  const left0 = parseFloat(el.style.left);
  $$('#auTrack .tl-clip').forEach((x) => x.classList.toggle('sel', x === el));
  auPanel();
  let moved = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (Math.abs(dx) > 3) moved = true;
    if (!moved) return;
    const dt = dx / pps;
    if (h === 'l') {
      c.in = Math.max(0, Math.min(start.out - 0.2, start.in + dt));
      auLayout(c);
    } else if (h === 'r') {
      c.out = Math.min(c.buffer.duration, Math.max(start.in + 0.2, start.out + dt));
      auLayout(c);
    } else {
      el.classList.add('drag');
      el.style.left = `${left0 + dx}px`;
    }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!moved) return auRender();
    if (!h) {
      // drop position → new order (by clip centres)
      const centre = (left0 + (ev.clientX - x0)) / pps + auLen(c) / 2;
      const rest = au.clips.filter((x) => x !== c);
      let acc = 0;
      let to = rest.length;
      for (let i = 0; i < rest.length; i++) {
        if (centre < acc + auLen(rest[i]) / 2) {
          to = i;
          break;
        }
        acc += auLen(rest[i]);
      }
      rest.splice(to, 0, c);
      au.clips = rest;
      if (to !== idx0) toast('Order changed ✓', { ms: 1500 });
    }
    auStop();
    auEdited();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});

function auSeekFrom(e) {
  const r = $('#auInner').getBoundingClientRect();
  auSeek((e.clientX - r.left) / auPps());
}
function auSeek(t) {
  const was = !!au.playing && !au.playing.only;
  auStop();
  au.t = Math.max(0, Math.min(auTotal(), t));
  auPlayhead();
  if (was) auStart();
}
$('#auRuler').addEventListener('pointerdown', auSeekFrom);
$('#auHandle').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const h = e.currentTarget;
  h.setPointerCapture(e.pointerId);
  const mv = (ev) => auSeekFrom(ev);
  h.addEventListener('pointermove', mv);
  h.addEventListener('pointerup', () => h.removeEventListener('pointermove', mv), { once: true });
});
$('#auZoom').addEventListener('input', (e) => {
  au.zoom = Number(e.target.value);
  auRender();
});
window.addEventListener('resize', () => $('#view-audio').classList.contains('is-active') && auRender());

/* ---------- playback / rendering share one scheduler ---------- */
/** Gain envelope for a clip (volume + fades), sampled from local time `from` to the end. */
function auEnvelope(c, from) {
  const L = auLen(c);
  const n = Math.max(2, Math.ceil((L - from) * 50));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = from + ((L - from) * i) / (n - 1);
    let g = 1;
    if (c.fi) g = Math.min(g, l / c.fi);
    if (c.fo) g = Math.min(g, (L - l) / c.fo);
    curve[i] = Math.max(0, g) * c.vol;
  }
  return curve;
}

/** Schedules the timeline from time `t` into `dest`; returns the source nodes. */
function auSchedule(ctx, dest, t, clips = au.clips, at = ctx.currentTime + 0.05) {
  const nodes = [];
  let acc = 0;
  for (const c of clips) {
    const L = auLen(c);
    const s = acc;
    acc += L;
    if (t >= s + L - 0.01) continue;
    const local = Math.max(0, t - s);
    const when = at + Math.max(0, s - t);
    const src = ctx.createBufferSource();
    src.buffer = c.buffer;
    const g = ctx.createGain();
    g.gain.setValueCurveAtTime(auEnvelope(c, local), when, L - local);
    src.connect(g).connect(dest);
    src.start(when, c.in + local, L - local);
    nodes.push(src);
  }
  return nodes;
}

function auStart(only = null) {
  const total = only ? auLen(only) : auTotal();
  if (!total) return;
  const actx = audioContext();
  if (actx.state === 'suspended') actx.resume();
  if (!only && au.t >= total - 0.05) au.t = 0;
  const from = only ? 0 : au.t;
  const at = actx.currentTime + 0.05;
  const nodes = auSchedule(actx, actx.destination, from, only ? [only] : au.clips, at);
  au.playing = { from, at, nodes, total, only, base: only ? auStarts()[au.clips.indexOf(only)] : 0 };
  const tick = () => {
    if (!au.playing) return;
    const p = au.playing;
    const local = p.from + Math.max(0, actx.currentTime - p.at);
    au.t = p.base + Math.min(local, p.total);
    auPlayhead();
    const sc = $('#auScroll');
    const x = au.t * auPps();
    if (x > sc.scrollLeft + sc.clientWidth - 30 || x < sc.scrollLeft) sc.scrollLeft = x - 60;
    if (local >= p.total) return auStop();
    au.raf = requestAnimationFrame(tick);
  };
  au.raf = requestAnimationFrame(tick);
  auPlayhead();
}
function auStop() {
  cancelAnimationFrame(au.raf);
  if (au.playing) for (const n of au.playing.nodes) try { n.stop(); } catch {}
  au.playing = null;
  if ($('#auPlay')) auPlayhead();
}
$('#auPlay').addEventListener('click', () => (au.playing ? auStop() : auStart()));
$('#auToStart').addEventListener('click', () => auSeek(0));
$('#auPlayClip').addEventListener('click', () => {
  const c = auSel();
  if (!c) return;
  auStop();
  auStart(c);
});

/* ---------- clip actions ---------- */
function auClipAt(t) {
  const starts = auStarts();
  for (let i = 0; i < au.clips.length; i++) if (t >= starts[i] && t < starts[i] + auLen(au.clips[i])) return { c: au.clips[i], local: t - starts[i], i };
  return null;
}
$('#auSplit').addEventListener('click', () => {
  const hit = auClipAt(au.t);
  if (!hit || hit.local < 0.1 || auLen(hit.c) - hit.local < 0.1) return toast('Move the playhead inside a clip to split it.', { error: true });
  auStop();
  const b = { ...hit.c, id: `a${++au.uid}`, in: hit.c.in + hit.local, fi: 0 };
  hit.c.out = b.in;
  hit.c.fo = 0;
  au.clips.splice(hit.i + 1, 0, b);
  au.sel = b.id;
  auEdited();
});
$('#auDup').addEventListener('click', () => {
  const c = auSel();
  if (!c) return;
  const i = au.clips.indexOf(c);
  const d = { ...c, id: `a${++au.uid}` };
  au.clips.splice(i + 1, 0, d);
  au.sel = d.id;
  auEdited();
});
function auDelete() {
  const c = auSel();
  if (!c) return;
  auStop();
  const i = au.clips.indexOf(c);
  au.clips.splice(i, 1);
  au.sel = au.clips[Math.min(i, au.clips.length - 1)]?.id || null;
  auEdited();
}
$('#auDel').addEventListener('click', auDelete);
const auMove = (d) => {
  const c = auSel();
  if (!c) return;
  const i = au.clips.indexOf(c);
  const j = i + d;
  if (j < 0 || j >= au.clips.length) return;
  auStop();
  [au.clips[i], au.clips[j]] = [au.clips[j], au.clips[i]];
  auEdited();
};
$('#auLeft').addEventListener('click', () => auMove(-1));
$('#auRight').addEventListener('click', () => auMove(1));
const auSet = (fn) => {
  const c = auSel();
  if (!c) return;
  auStop();
  fn(c);
  c.in = Math.max(0, Math.min(c.in, c.buffer.duration - 0.2));
  c.out = Math.min(c.buffer.duration, Math.max(c.in + 0.2, c.out));
  const L = auLen(c);
  c.fi = Math.min(c.fi, L / 2);
  c.fo = Math.min(c.fo, L / 2);
  auEdited();
};
$('#auIn').addEventListener('change', (e) => auSet((c) => (c.in = Number(e.target.value) || 0)));
$('#auOut').addEventListener('change', (e) => auSet((c) => (c.out = Number(e.target.value) || c.buffer.duration)));
$('#auInHere').addEventListener('click', () => {
  const hit = auClipAt(au.t);
  if (!hit || hit.c !== auSel()) return toast('Put the playhead inside the selected clip first.', { error: true });
  auSet((c) => (c.in += hit.local));
});
$('#auOutHere').addEventListener('click', () => {
  const hit = auClipAt(au.t);
  if (!hit || hit.c !== auSel()) return toast('Put the playhead inside the selected clip first.', { error: true });
  auSet((c) => (c.out = c.in + hit.local));
});
$('#auReset').addEventListener('click', () => auSet((c) => ((c.in = 0), (c.out = c.buffer.duration))));
$('#auVol').addEventListener('input', (e) => {
  const c = auSel();
  if (!c) return;
  c.vol = Number(e.target.value) / 100;
  $('#auVolOut').textContent = `${e.target.value}%`;
});
$('#auVol').addEventListener('change', () => auSel() && auEdited());
[['#auFi', 'fi', '#auFiOut'], ['#auFo', 'fo', '#auFoOut']].forEach(([sel, key, out]) => {
  $(sel).addEventListener('input', (e) => {
    const c = auSel();
    if (!c) return;
    c[key] = Math.min(Number(e.target.value), auLen(c) / 2);
    $(out).textContent = `${c[key]}s`;
  });
  $(sel).addEventListener('change', () => auSel() && auEdited());
});
$$('[data-ap]').forEach((t) =>
  t.addEventListener('click', () => {
    if (!t.classList.contains('tab')) return;
    $$('.au-tabs .tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $$('#view-audio .ipanel').forEach((p) => p.classList.toggle('is-active', p.dataset.ap === t.dataset.ap));
  }),
);
document.addEventListener('keydown', (e) => {
  if (!$('#view-audio').classList.contains('is-active') || e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.code === 'Space') e.preventDefault(), au.playing ? auStop() : auStart();
  else if (e.key === 's' || e.key === 'S') $('#auSplit').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(), auDelete();
});

/* ---------- export ---------- */
function setChips(id, attr, val) {
  $$(`#${id} .chip`).forEach((x) => x.setAttribute('aria-checked', x.dataset[attr] === val));
}
setChips('auFmt', 'f', au.fmt);
setChips('auRate', 'r', au.rate);
$('#auRateField').hidden = au.fmt !== 'mp3';
$('#auExt').textContent = `.${au.fmt}`;
$$('#auFmt .chip').forEach((b) =>
  b.addEventListener('click', () => {
    au.fmt = b.dataset.f;
    store.set('auFmt', au.fmt);
    setChips('auFmt', 'f', au.fmt);
    $('#auRateField').hidden = au.fmt !== 'mp3';
    $('#auExt').textContent = `.${au.fmt}`;
    auEdited();
  }),
);
$$('#auRate .chip').forEach((b) =>
  b.addEventListener('click', () => {
    au.rate = b.dataset.r;
    store.set('auRate', au.rate);
    setChips('auRate', 'r', au.rate);
    auEdited();
  }),
);

function encodeWav(buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + n * ch * 2, true);
  w(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch).keys()].map((i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return new Blob([out], { type: 'audio/wav' });
}

function encodeMp3(buf, kbps, onProgress) {
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : null;
  return new Promise((resolve, reject) => {
    const w = new Worker('/js/mp3-worker.js');
    w.onmessage = (e) => {
      if (e.data.progress != null) onProgress(e.data.progress);
      else {
        w.terminate();
        e.data.error ? reject(new Error(`MP3 encoding failed: ${e.data.error}`)) : resolve(e.data.done);
      }
    };
    w.onerror = (e) => (w.terminate(), reject(new Error(e.message || 'MP3 encoder failed to load')));
    w.postMessage({ left, right, sampleRate: buf.sampleRate, kbps: Number(kbps) }, [left.buffer, ...(right ? [right.buffer] : [])]);
  });
}

const auStage = (t) => (($('#auStage').hidden = !t), ($('#auStage').textContent = t || ''));
const canShareAudio = (() => {
  try {
    return Boolean(navigator.canShare?.({ files: [new File([new Blob(['x'], { type: 'audio/mpeg' })], 'x.mp3', { type: 'audio/mpeg' })] }));
  } catch {
    return false;
  }
})();
const auFileName = () => `${cleanName($('#auFileName').value || 'newsgram audio')}.${au.out?.ext || au.fmt}`;

$('#auExport').addEventListener('click', async () => {
  const total = auTotal();
  if (!total) return;
  if (!isPhone) primeSave();
  auStop();
  const btn = $('#auExport');
  busy(btn, true);
  try {
    const SR = 44100;
    const stereo = au.clips.some((c) => c.buffer.numberOfChannels > 1);
    auStage('Combining clips…');
    const off = new OfflineAudioContext(stereo ? 2 : 1, Math.ceil(total * SR), SR);
    auSchedule(off, off.destination, 0, au.clips, 0);
    const mixed = await off.startRendering();
    let blob;
    if (au.fmt === 'wav') {
      auStage('Writing WAV…');
      blob = encodeWav(mixed);
    } else {
      auStage('Encoding MP3…');
      blob = await encodeMp3(mixed, au.rate, (p) => auStage(`Encoding MP3… ${Math.round(p * 100)}%`));
    }
    if (au.out?.url) URL.revokeObjectURL(au.out.url);
    au.out = { blob, ext: au.fmt, url: URL.createObjectURL(blob), photos: null };
    auStage('');
    $('#auOutPlayer').src = au.out.url;
    $('#auOutInfo').textContent = `· ${fmtDur(total) || '0:00'} · ${fmtSize(blob.size)} · ${au.fmt.toUpperCase()}${au.fmt === 'mp3' ? ` ${au.rate} kbps` : ''}`;
    auSyncOut();
    $('#auOutBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!isPhone && folderName()) await auSaveFolder();
    else toast(isPhone ? 'Ready ✓ — choose where to save it' : 'Ready ✓ — choose where to save it', { ms: 4000 });
  } catch (e) {
    auStage('');
    toast(`Couldn't combine the audio: ${e.message}`, { error: true, ms: 9000 });
  } finally {
    busy(btn, false);
  }
});

function auSyncOut() {
  $('#auOutBox').hidden = !au.out;
  if (!au.out) return;
  const pick = supportsFolders();
  $('#auToFolder').hidden = isPhone || !pick;
  $('#auSaveAs').hidden = isPhone || !pick;
  $('#auToFolder').textContent = folderName() ? `📁 Save to “${folderName()}”` : '📁 Choose folder & save';
  $('#auToFiles').hidden = !isPhone;
  $('#auToPhotos').hidden = !(isPhone && canShareFiles && state.config.features.transcode);
  $('#auToPhotos').textContent = au.out.photos ? '📱 Save video to Photos' : '🎞 Save to Photos (as video)';
  $('#auDownload').hidden = isPhone;
  $('#auDownload').textContent = pick ? '⬇ Downloads folder' : '⬇ Download';
  $('#auOutHint').textContent = isPhone
    ? 'Photos only stores pictures and videos — “Save to Photos” turns the audio into a video with a waveform. For the audio file itself, use “Save to Files”.'
    : pick
      ? 'Pick a folder once (e.g. Desktop) — after that, every new file saves there automatically.'
      : 'This browser saves to its Downloads folder. To pick a folder, use Chrome or Edge.';
}
onFolderChange(() => au.out && auSyncOut());

async function auSaveFolder() {
  if (!au.out) return;
  if (!folderName()) {
    try {
      if (!(await chooseFolder())) return;
    } catch (e) {
      return toast(e.message, { error: true });
    }
  }
  return doSave(au.out.blob, 'au', au.out.ext, { fallbackName: 'newsgram audio' });
}
$('#auToFolder').addEventListener('click', auSaveFolder);
$('#auSaveAs').addEventListener('click', () => au.out && doSave(au.out.blob, 'au', au.out.ext, { askWhere: true, fallbackName: 'newsgram audio' }));
$('#auDownload').addEventListener('click', () => au.out && download(au.out.blob, auFileName()));
$('#auToFiles').addEventListener('click', async () => {
  if (!au.out) return;
  const file = new File([au.out.blob], auFileName(), { type: au.out.blob.type });
  if (canShareAudio) {
    try {
      return await navigator.share({ files: [file] }); // → "Save to Files"
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  download(au.out.blob, file.name);
});
$('#auToPhotos').addEventListener('click', async () => {
  if (!au.out) return;
  const btn = $('#auToPhotos');
  if (!au.out.photos) {
    // Step 1: make the video on the server (needs a fresh tap afterwards to open the share sheet).
    busy(btn, true);
    try {
      toast('Making a video for Photos…', { ms: 60000 });
      const up = await uploadMedia(new Blob([au.out.blob], { type: au.out.blob.type }));
      const v = await api('/api/audio/tovideo', { method: 'POST', body: JSON.stringify({ name: up.name }) });
      au.out.photos = await (await fetch(v.path)).blob();
      toast('Video ready ✓ — tap “Save video to Photos”', { ms: 5000 });
    } catch (e) {
      toast(`Couldn't make the video: ${e.message}`, { error: true, ms: 9000 });
    } finally {
      busy(btn, false);
      auSyncOut();
    }
    return;
  }
  const file = new File([au.out.photos], auFileName().replace(/\.\w+$/, '.mp4'), { type: 'video/mp4' });
  try {
    await navigator.share({ files: [file] }); // → "Save Video"
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn't open the share sheet: ${e.message}`, { error: true });
  }
});
$('#auUse').addEventListener('click', () => {
  if (!au.out) return;
  music.custom = { name: ($('#auFileName').value.trim() || 'My audio').slice(0, 40), url: URL.createObjectURL(au.out.blob) };
  music.id = 'custom';
  renderTracks();
  updateMusicNote();
  toast('Added to the studio Music tab as “Your upload” ✓');
});

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
  if (!pickMime().includes('mp4') && !f.transcode) $('#dlReel').textContent = '🎬 Record video (WebM)';
  renderSources();
  renderRecent();
  syncSearchOpts();
  loadCatalog().then(updateMusicNote);
  onFolderChange(syncFolderChips);
  initSave();
  checkGrabParam();
}
boot();
