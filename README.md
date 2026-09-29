# Newsgram

Turn the latest stories from India's big newsrooms into AI-rephrased, 1:1 Instagram posts and reels — in the browser.

**Flow:** pick sources + a category → the app pulls fresh stories and rewrites the headlines with AI → open one in the studio → edit copy, reposition/zoom the image, pick a layout → download JPG/PNG, record an MP4 reel, grab the story's own video, or publish straight to Instagram.

| Sources (preset) | Categories |
|---|---|
| The Hindu · Indian Express · Times of India · Hindustan Times · NDTV · CNN-News18 (formerly CNN-IBN) — plus their official X accounts | Top · India · World · Business · Sports · Entertainment · Tech |

## Run it

```bash
npm install
cp .env.example .env      # add your keys (all optional)
npm start                 # http://localhost:3000
```

- `npm run check-feeds` — tests every preset RSS feed and shows item/image counts. If a publisher moves a feed, edit `server/sources.js`. Feeds that fail fall back to Google News automatically (no images; add one in the studio).
- `npm run mock` — offline sample data for design work.

## Features

- **AI rewriting** (Anthropic Claude): batch-rewrites the story grid, and the studio's *Rephrase* button rewrites from the full original article, including an Instagram caption with hashtags. Tones: punchy / neutral / explainer. Languages: English, Hindi, Tamil, Telugu, Marathi, Bengali. Without a key the app falls back to a basic trim-and-shorten rewrite.
- **Studio**: 1080×1080 canvas, 4 layouts (Spotlight, Split, Frame, Bold), 6 accent colours, 4 headline fonts, drag to reposition, scroll/pinch/slider to zoom, “fit whole image” with blurred backdrop, shade control, alternate article images, upload or paste your own. Wrap words in `*stars*` to highlight them.
- **Downloads**: JPG / PNG, animated MP4 reel (5–15 s, zoom + word-by-word headline reveal), and the source article's video when it exposes a direct file.
- **Instagram**: publishes images or Reels via the official Content Publishing API.

## Instagram setup

Instagram fetches the media from your server, so posting needs the app online at a public HTTPS URL.

1. Convert your Instagram account to **Business** or **Creator** and link it to a Facebook Page.
2. Create an app at developers.facebook.com, add the Instagram product, and request `instagram_basic` + `instagram_content_publish` (+ `pages_show_list`, `pages_read_engagement` for Facebook Login).
3. Generate a **long-lived access token** and find your **Instagram user ID** (Graph API Explorer: `me/accounts` → page → `?fields=instagram_business_account`).
4. Set `IG_USER_ID`, `IG_ACCESS_TOKEN`, `PUBLIC_BASE_URL` (and `IG_GRAPH_HOST=graph.instagram.com` if your token is from *Instagram Login*).

Testing locally? Run a tunnel (`ngrok http 3000`) and put the tunnel URL in `PUBLIC_BASE_URL`.

## Deploy to Render (free)

1. Push this repo to GitHub.
2. On render.com → **New → Blueprint** → pick the repo (`render.yaml` is included).
3. Fill in the env vars — set `APP_PASSWORD` so only you can use it (browsers ask once; any username works), and set `PUBLIC_BASE_URL` to the `https://….onrender.com` address Render gives you.
4. On your phone, open that address and use **Add to Home Screen** for an app-like icon.

Free instances sleep when idle, so the first request after a pause is slow. Rendered media is kept for 24 h in `media/`.

## Optional: X (Twitter) posts

The X API isn't free. With a paid-tier bearer token in `X_BEARER_TOKEN`, a *From X* tab shows the publishers' latest posts, including their photos and downloadable videos.

## Stack

Node 20+ / Express 5 · cheerio + fast-xml-parser for feeds and article pages · vanilla ES modules + Canvas 2D (no build step) · MediaRecorder for reels, ffmpeg-static to convert to H.264 MP4 for Instagram.

## A note on rights

Headlines are rewritten and attributed, but the photos and videos belong to the publishers. Credit the source (the card does this by default) and check you're allowed to reuse media before posting — especially on a monetised page.
