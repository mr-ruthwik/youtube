require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.static('public'));

// ── Binary resolution ──────────────────────────────────────────────────────
// Priority: process.cwd()/yt-dlp (installed by build script) → /app/yt-dlp → PATH
const YTDLP_CANDIDATES = [
  path.join(process.cwd(), 'yt-dlp'),     // Render: build script puts it here
  path.join(__dirname, 'yt-dlp'),         // same dir as server.js
  '/app/yt-dlp',                          // fallback absolute
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
];

let _ytdlpBin = null;
function getYtDlpBin() {
  if (_ytdlpBin) return _ytdlpBin;
  for (const candidate of YTDLP_CANDIDATES) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
        _ytdlpBin = candidate;
        console.log(`[startup] yt-dlp found at: ${candidate}`);
        return candidate;
      }
    } catch (_) {}
  }
  console.warn('[startup] yt-dlp not found in known paths — using PATH');
  _ytdlpBin = 'yt-dlp';
  return _ytdlpBin;
}

console.log('[startup] cwd =', process.cwd());
console.log('[startup] __dirname =', __dirname);
getYtDlpBin();

// ── Rate limiting ──────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 10;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const hits = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  hits.push(now);
  rateLimitMap.set(ip, hits);
  if (hits.length > max) return res.status(429).send('Too many requests. Please wait a minute.');
  next();
}

// ── URL validation ─────────────────────────────────────────────────────────
function isValidYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'youtu.be') &&
      (u.searchParams.get('v') || u.pathname.length > 1)
    );
  } catch { return false; }
}

function safeFilename(title) {
  return (title || 'download').replace(/[^a-z0-9_\-\s]/gi, '').trim().slice(0, 80) || 'download';
}

// ── Cookie / secret paths ──────────────────────────────────────────────────
const COOKIES_PATH = '/etc/secrets/cookies.txt';
const PO_TOKEN_PATH = '/etc/secrets/po_token.txt';

function getCookieArgs() {
  const args = [];
  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
    console.log('[bot] Using cookies file');
  }
  return args;
}

function getPoTokenArgs() {
  const args = [];
  if (fs.existsSync(PO_TOKEN_PATH)) {
    try {
      const token = fs.readFileSync(PO_TOKEN_PATH, 'utf8').trim();
      if (token) {
        args.push('--extractor-args', `youtube:po_token=web+${token}`);
        console.log('[bot] Using PO token');
      }
    } catch (_) {}
  }
  return args;
}

// ── Advanced strategy matrix for bypassing bot detection ──────────────────
// Each strategy is tried in order. Different combos hit different YouTube endpoints.
// tv_embedded and mediaconnect are less monitored server-side clients.
const STRATEGIES = [
  {
    name: 'tv_embedded',
    extractorArgs: 'youtube:player_client=tv_embedded',
    extraArgs: ['--no-check-certificates'],
  },
  {
    name: 'ios+cookies',
    extractorArgs: 'youtube:player_client=ios',
    extraArgs: ['--no-check-certificates', '--sleep-requests', '1'],
  },
  {
    name: 'android_vr',
    extractorArgs: 'youtube:player_client=android_vr',
    extraArgs: ['--no-check-certificates'],
  },
  {
    name: 'web_creator',
    extractorArgs: 'youtube:player_client=web_creator',
    extraArgs: ['--no-check-certificates', '--sleep-requests', '1'],
  },
  {
    name: 'android',
    extractorArgs: 'youtube:player_client=android',
    extraArgs: ['--no-check-certificates', '--sleep-requests', '2'],
  },
  {
    name: 'mweb',
    extractorArgs: 'youtube:player_client=mweb',
    extraArgs: ['--no-check-certificates'],
  },
];

// Rotate user agents to avoid fingerprinting
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];

function getBaseArgs(strategy) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return [
    '--extractor-args', strategy.extractorArgs,
    '--user-agent', ua,
    '--no-warnings',
    ...strategy.extraArgs,
    ...getCookieArgs(),
    ...getPoTokenArgs(),
  ];
}

// ── Fetch title + verify URL is accessible using --print ──────────────────
// Using --print title is faster and more reliable than --get-title.
// We also pass --skip-download so we know the video IS accessible before downloading.
function fetchTitleWithStrategy(url, strategy, signal) {
  return new Promise((resolve) => {
    const bin = getYtDlpBin();
    console.log(`[fetchTitle] strategy=${strategy.name}`);

    const args = [
      '--print', 'title',
      '--no-playlist',
      '--skip-download',
      ...getBaseArgs(strategy),
      url
    ];

    const proc = spawn(bin, args);
    let output = '';
    let errOutput = '';

    const timer = setTimeout(() => { proc.kill(); resolve(null); }, 25000);
    const onAbort = () => { clearTimeout(timer); proc.kill(); resolve(null); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', d => (output += d.toString()));
    proc.stderr.on('data', d => (errOutput += d.toString()));

    proc.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) {
        console.error(`[fetchTitle] strategy=${strategy.name} exit=${code}: ${errOutput.slice(0, 300)}`);
        resolve(null);
      } else {
        const t = output.trim().split('\n')[0]; // first line = title
        resolve(t || null);
      }
    });
    proc.on('error', err => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      console.error('[fetchTitle] spawn error:', err.message);
      resolve(null);
    });
  });
}

async function fetchTitle(url, signal) {
  for (const strategy of STRATEGIES) {
    if (signal && signal.aborted) return null;
    const title = await fetchTitleWithStrategy(url, strategy, signal);
    if (title) return { title, strategy };
    // Small delay between strategy attempts to avoid rapid-fire detection
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ── Download with a specific strategy ────────────────────────────────────
function runDownload({ url, format, strategy, outputPath, send, downloadProcRef, lastPercentRef }) {
  return new Promise((resolve) => {
    const bin = getYtDlpBin();
    console.log(`[download] strategy=${strategy.name} format=${format}`);

    let args;
    if (format === 'mp3') {
      args = [
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--ffmpeg-location', 'ffmpeg',
        '--no-playlist', '--newline',
        ...getBaseArgs(strategy),
        '-o', outputPath,
        url
      ];
    } else {
      // Prefer mp4+m4a. Fallback chain handles cases where those streams aren't available.
      args = [
        '-f', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', 'ffmpeg',
        '--no-playlist', '--newline',
        ...getBaseArgs(strategy),
        '-o', outputPath,
        url
      ];
    }

    const proc = spawn(bin, args);
    downloadProcRef.proc = proc;

    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const pctMatch = line.match(/(\d+\.?\d*)%/);
        if (pctMatch) {
          const pct = Math.min(Math.round(parseFloat(pctMatch[1])), 99);
          if (pct > lastPercentRef.value) {
            lastPercentRef.value = pct;
            const stage = pct >= 95 ? 'Merging...' : pct >= 80 ? 'Converting...' : pct >= 50 ? 'Downloading...' : 'Buffering...';
            send({ type: 'progress', percent: pct, stage });
          }
        }
        const speedMatch = line.match(/at\s+([\d.]+\s*\w+\/s)/i);
        const etaMatch = line.match(/ETA\s+([\d:]+)/i);
        if (speedMatch || etaMatch) {
          send({ type: 'meta', speed: speedMatch?.[1] || null, eta: etaMatch?.[1] || null });
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const line = chunk.toString();
      if (line.includes('time=') && lastPercentRef.value >= 90) {
        lastPercentRef.value = Math.min(lastPercentRef.value + 1, 99);
        send({ type: 'progress', percent: lastPercentRef.value, stage: 'Merging...' });
      }
    });

    proc.on('close', code => {
      downloadProcRef.proc = null;
      // yt-dlp sometimes exits 1 but file is good (post-process warnings)
      const fileOk = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000;
      resolve({ success: fileOk, code, fileOk });
    });

    proc.on('error', err => {
      downloadProcRef.proc = null;
      console.error('[download] spawn error:', err.message);
      resolve({ success: false, code: -1, fileOk: false });
    });
  });
}

// ── /start SSE endpoint ───────────────────────────────────────────────────
app.get('/start', rateLimit, async (req, res) => {
  const { url, format, id } = req.query;

  if (!isValidYouTubeUrl(url)) return res.status(400).send('Invalid YouTube URL');
  if (!['mp3', 'mp4'].includes(format)) return res.status(400).send('Invalid format');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sseEnded = false;
  const send = data => {
    if (!sseEnded) try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };
  const endSSE = () => { if (!sseEnded) { sseEnded = true; res.end(); } };

  const abortCtrl = new AbortController();
  let clientDisconnected = false;
  const downloadProcRef = { proc: null };

  req.on('close', () => {
    clientDisconnected = true;
    abortCtrl.abort();
    if (downloadProcRef.proc) downloadProcRef.proc.kill();
  });

  // STEP 1: Fetch title — also discovers which strategy works for this video/IP combo
  send({ type: 'status', stage: 'Connecting to YouTube...' });

  const titleResult = await fetchTitle(url, abortCtrl.signal);

  if (clientDisconnected) { endSSE(); return; }

  if (!titleResult) {
    send({
      type: 'title_error',
      message: 'YouTube is blocking this server\'s IP. Try adding cookies (see README) or wait a few minutes.'
    });
    endSSE();
    return;
  }

  const { title: videoTitle, strategy: workingStrategy } = titleResult;
  console.log(`[flow] Title="${videoTitle}" via strategy=${workingStrategy.name}`);

  send({ type: 'title', title: videoTitle });
  await new Promise(r => setTimeout(r, 200));
  if (clientDisconnected) { endSSE(); return; }

  // STEP 2: Download — start with the strategy that worked for title, then try others
  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const safeId = String(id).replace(/[^a-z0-9]/gi, '').slice(0, 30) || Date.now().toString();
  const outputPath = path.join(process.cwd(), `temp_${format}_${safeId}.${ext}`);

  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  send({ type: 'progress', percent: 2, stage: 'Starting download...' });

  // Reorder strategies: put the working one first
  const orderedStrategies = [
    workingStrategy,
    ...STRATEGIES.filter(s => s.name !== workingStrategy.name)
  ];

  const lastPercentRef = { value: 2 };
  let result = null;

  for (let i = 0; i < orderedStrategies.length; i++) {
    const strategy = orderedStrategies[i];
    if (clientDisconnected) break;

    if (i > 0) {
      send({ type: 'status', stage: `Trying method ${i + 1}/${orderedStrategies.length}...` });
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      await new Promise(r => setTimeout(r, 800)); // brief pause between attempts
    }

    result = await runDownload({
      url, format, strategy, outputPath, send,
      downloadProcRef, lastPercentRef
    });

    if (result.success) {
      console.log(`[flow] Download succeeded with strategy=${strategy.name}`);
      break;
    }
    console.warn(`[flow] Download failed with strategy=${strategy.name}`);
  }

  if (clientDisconnected) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  if (!result || !result.success) {
    send({ type: 'error', message: 'Download failed after all methods. Video may be age-restricted, DRM-protected, or region-locked.' });
    endSSE();
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }

  send({ type: 'progress', percent: 100, stage: 'Done!' });

  try {
    const fileBuffer = fs.readFileSync(outputPath);
    const base64 = fileBuffer.toString('base64');
    const mimeType = format === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    const fname = safeFilename(videoTitle) + '.' + ext;
    send({ type: 'file', base64, mimeType, filename: fname });
  } catch (e) {
    console.error('[flow] Failed to read output file:', e.message);
    send({ type: 'error', message: 'Failed to read output file.' });
  } finally {
    if (fs.existsSync(outputPath)) try { fs.unlinkSync(outputPath); } catch (_) {}
    endSSE();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Running on port ${PORT}`);
});

process.on('uncaughtException', err => console.error('[uncaught]', err));
process.on('unhandledRejection', reason => console.error('[unhandled]', reason));