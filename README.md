# Newsgram

Turn the latest stories from India's big newsrooms into AI-rephrased, 1:1 Instagram posts and reels — in the browser.

**Flow:** pick sources + a category → the app pulls fresh stories and rewrites the headlines with AI → open one in the studio → edit copy, reposition/zoom the image, pick a layout → download JPG/PNG, record an MP4 reel, grab the story's own video, or publish straight to Instagram.

| Sources (preset) | Categories |
|---|---|
| **National (English):** The Hindu · Indian Express · Times of India · Hindustan Times · NDTV · CNN-News18 (formerly CNN-IBN) | Top · Tamil Nadu · India · World · Business · Sports · Cinema & Entertainment · Tech |
| **Tamil:** Thanthi TV · Puthiya Thalaimurai · Hindu Tamil Thisai · Polimer News · Behindwoods (cinema & TN only) | |

Each source is read from its RSS feed; when a feed is thin or missing the app reads the publisher's section page directly, and Google News (site search) is the last resort.

## Run it

```bash
npm install
cp .env.example .env      # add your keys (all optional)
npm start                 # http://localhost:3000
```

- `npm run check-feeds` (or `npm run check-feeds -- tamil`) — tests every preset feed and shows item/image counts. If a publisher moves a feed, edit `server/sources.js`. Feeds that fail fall back to Google News automatically (no images; add one in the studio).
- `npm run mock` — offline sample data for design work.

## Features

- **AI rewriting** (Anthropic Claude): batch-rewrites the story grid, and the studio's *Rephrase* button rewrites from the full original article, including an Instagram caption with hashtags. Tones: punchy / neutral / explainer. Languages: English, Hindi, Tamil, Telugu, Marathi, Bengali. Without a key the app falls back to a basic trim-and-shorten rewrite.
- **Studio**: 1080×1080 canvas, 4 layouts (Spotlight, Split, Frame, Bold), 6 accent colours, 5 headline fonts (incl. Catamaran for bold Tamil), drag to reposition, scroll/pinch/slider to zoom, “fit whole image” with blurred backdrop, shade control, alternate article images, upload or paste your own. Wrap words in `*stars*` to highlight them.
- **Downloads**: JPG / PNG, animated MP4 reel (5–15 s, zoom + word-by-word headline reveal), and the source article's video when it exposes a direct file.
- **Music for reels**: 13 built-in tracks — *News tones* (Breaking News, Flash News, Top Headlines, Countdown Clock, Bulletin Intro, Urgent Alert) and *Background beds* (Tamil Mass Beat, Breaking Pulse, Headline Rise, Morning Brief, Lo-fi Desk, Tech Wave, Desi Beat) — or upload your own; preview, volume and start point; fades in/out and is baked into the MP4 and the Instagram Reel. The built-in tracks are composed from scratch by `scripts/compose-music.py` (pure synthesis — no samples), so they're free to use anywhere.
- **Video grabber** (⬇ *Grab video* in the top bar): paste a link from YouTube, X, Instagram, Facebook, ShareChat or 1,800+ other sites → preview → pick Best / 1080p / 720p / 480p / MP3 → download, post it to Instagram as a Reel (auto-converted to H.264/AAC), or turn it into a news card. Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp), downloaded automatically on `npm install`; run `npm run update-ytdlp` whenever a site stops working. Only reuse videos you have permission to — credit the creator.
- **Video editor** (🎬 *Editor* in the top bar, or *Edit in video editor* after a grab): multi-clip timeline — add clips from your device or from links, drag clip edges to trim, drag clips to reorder, split at the playhead, duplicate/delete; play/pause with a draggable playhead and ruler; per-clip framing (fill + zoom + drag-to-pan, or fit with blurred edges), top/bottom/left/right crop and clip volume; a music layer you can drag along the timeline, with song start point, volume and **repeat-if-shorter** toggle; output as Original, 9:16, 1:1, 4:5 or 16:9 at Instagram sizes → download MP4 or post as a Reel.
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

## Video grabber tips

- **YouTube on Render:** YouTube often blocks cloud servers ("confirm you're not a bot"). Downloads from Newsgram running on your own computer work far more reliably.
- **Instagram / private posts:** many Instagram links need a logged-in session. Export your browser cookies in Netscape format (e.g. the *Get cookies.txt LOCALLY* extension) and paste the file's contents into the `YTDLP_COOKIES` environment variable (or point `YTDLP_COOKIES_FILE` at the file). Use a spare account — the cookies act as your login.
- Downloads are capped at 500 MB and kept for 24 h.

## Optional: X (Twitter) posts

The X API isn't free. With a paid-tier bearer token in `X_BEARER_TOKEN`, a *From X* tab shows the publishers' latest posts, including their photos and downloadable videos.

## Stack

Node 20+ / Express 5 · cheerio + fast-xml-parser for feeds and article pages · vanilla ES modules + Canvas 2D (no build step) · MediaRecorder for reels, ffmpeg-static to convert to H.264 MP4 for Instagram.

## A note on rights

Headlines are rewritten and attributed, but the photos and videos belong to the publishers. Credit the source (the card does this by default) and check you're allowed to reuse media before posting — especially on a monetised page.
