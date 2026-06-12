# YT Downloader

Node.js + Express YouTube downloader using yt-dlp and ffmpeg, deployed on Render.

---

## How It Works

1. User pastes a YouTube URL and picks MP4 or MP3
2. Frontend opens an SSE stream to `/start`
3. Server tries 6 different yt-dlp strategies to bypass YouTube bot detection
4. File is sent as base64 over SSE and downloaded in the browser

---

## Deployment (Render Free Tier)

Uses **nixpacks**. The `nixpacks.toml` handles everything:
- `ffmpeg` installed via apt
- `yt-dlp` binary downloaded fresh during the **build phase** (so it's in the runtime)
- `node server.js` starts the app

Push to GitHub → Render auto-deploys.

---

## Fixing "Could not fetch title" / YouTube Bot Detection

Render's free tier IPs are shared datacenter IPs that YouTube frequently blocks.
The app tries 6 strategies automatically, but for best results add **cookies**.

### Option A: Export Your Browser Cookies (Recommended)

1. In Chrome/Firefox, install the extension **"Get cookies.txt LOCALLY"** (Chrome) or **"cookies.txt"** (Firefox)
2. Log in to YouTube in your browser
3. Go to youtube.com and export cookies as `cookies.txt`
4. In Render dashboard → your service → **Environment** → **Secret Files**
5. Add a secret file at path `/etc/secrets/cookies.txt` and paste the cookie content
6. Redeploy

This is the most effective fix — YouTube trusts requests from logged-in accounts.

### Option B: PO Token (Advanced)

If cookies alone don't work:
1. Open YouTube in browser → DevTools → Network tab
2. Filter for `youtubei` requests
3. Find a request with `po_token` in the payload
4. Copy the token value
5. In Render → Secret Files → add `/etc/secrets/po_token.txt` with the token
6. Redeploy

### Why Does Bot Detection Happen?

- Render free tier uses shared IPs already flagged by YouTube
- Datacenter IPs get stricter treatment than residential ones
- YouTube constantly updates its bot detection

The app's 6-strategy rotation (`tv_embedded`, `ios`, `android_vr`, `web_creator`, `android`, `mweb`) 
gives it the best chance without cookies, but cookies are the reliable solution.

---

## Local Development

```bash
npm install
# Install yt-dlp locally:
# Windows: pip install yt-dlp   OR  winget install yt-dlp
# Mac/Linux: pip install yt-dlp
node server.js
```

Open http://localhost:3000

---

## Environment Variables

None required. Optional:
- `PORT` — defaults to 3000

---

## File Size Warning

Large videos (>500MB) may fail on Render free tier due to the 512MB RAM limit.
The file is held in memory as base64 before being sent to the browser.
For large files, consider streaming directly or using a paid tier.