// AI rewriting via the Anthropic Messages API, with an offline fallback so the
// app still works (plainer copy) when no API key is configured.

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const TONES = {
  neutral: 'clear, neutral and factual, like a wire-service headline',
  punchy: 'punchy and scroll-stopping for Instagram, but never clickbait or misleading',
  explainer: 'plain-language explainer that tells a first-time reader why this matters',
};

const LANGS = { en: 'English', hi: 'Hindi (Devanagari script)', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', bn: 'Bengali' };

const RULES = `Rules:
- Rephrase in your own words; never copy sentences from the source.
- Use ONLY facts present in the source. Do not add numbers, names, quotes or claims that are not there.
- Keep attributions ("police said", "according to") when the source has them.
- No emojis in headline or body.`;

async function callClaude(system, user, maxTokens = 1200) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Anthropic API ${res.status}`);
  const out = data.content?.map((c) => c.text || '').join('') || '';
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

/* ---------- offline fallback ---------- */
const words = (s) => s.split(/\s+/).filter(Boolean);
const clipWords = (s, n) => {
  const w = words(s);
  return w.length <= n ? s.trim() : w.slice(0, n).join(' ').replace(/[,;:]$/, '') + '…';
};
function offlineHeadline(title) {
  return clipWords(title.replace(/^(opinion|explained|watch|video|live updates?)\s*[:|]\s*/i, '').replace(/\s*\|.*$/, ''), 14);
}
function offlineBody(text, title) {
  const sentences = (text || '').replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g) || [text || title];
  return clipWords(sentences.slice(0, 3).join(' ').trim(), 55);
}
function offlineCaption(headline, body, sourceName) {
  return `${headline}\n\n${body}\n\nSource: ${sourceName}\n\n#news #india #breakingnews #newsupdate #${(sourceName || 'news').replace(/\W/g, '').toLowerCase()}`;
}

/** Rewrites many headlines in one call (used for the news grid). */
export async function rephraseBatch(items, { tone = 'punchy', lang = 'en' } = {}) {
  if (!aiEnabled()) {
    return { ai: false, items: items.map((i) => ({ id: i.id, headline: offlineHeadline(i.title), body: offlineBody(i.summary, i.title) })) };
  }
  const payload = items.map((i) => ({ id: i.id, title: i.title, summary: (i.summary || '').slice(0, 500) }));
  const system = `You are a news-desk editor preparing square Instagram news cards for a mass Indian audience. Tone: ${TONES[tone] || TONES.punchy}. Write in ${LANGS[lang] || 'English'}.\n${RULES}`;
  const user = `For each item write:
- "headline": max 12 words
- "body": 25-45 words summarising the story (if the summary is thin, stay short rather than inventing)
Return JSON only: {"items":[{"id":"...","headline":"...","body":"..."}]}

Items:
${JSON.stringify(payload)}`;
  const out = await callClaude(system, user, 4000);
  return { ai: true, items: out.items || [] };
}

/** Deep rewrite of one story from the original article text. */
export async function rephraseArticle({ title, summary, text, sourceName, tone = 'punchy', lang = 'en', handle = '' }) {
  const src = (text || summary || title || '').slice(0, 6000);
  if (!aiEnabled()) {
    const headline = offlineHeadline(title);
    const body = offlineBody(src, title);
    return { ai: false, headline, body, caption: offlineCaption(headline, body, sourceName) };
  }
  const system = `You are a news-desk editor preparing a 1:1 Instagram news card for a mass Indian audience. Tone: ${TONES[tone] || TONES.punchy}. Write in ${LANGS[lang] || 'English'}.\n${RULES}`;
  const user = `Original headline: ${title}
Publisher: ${sourceName}

Original article:
"""
${src}
"""

Return JSON only:
{"headline": "max 12 words",
 "body": "40-60 words: what happened, who, and why it matters",
 "caption": "Instagram caption: 2-3 short sentences, then a blank line, then 'Source: ${sourceName}', then 6-10 relevant hashtags${handle ? `, and end with 'Follow ${handle} for more'` : ''}"}`;
  return { ai: true, ...(await callClaude(system, user, 1500)) };
}
