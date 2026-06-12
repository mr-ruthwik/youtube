require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.static('public'));

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

// ── Sanitize filename ──────────────────────────────────────────────────────
function safeFilename(title) {
  return (title || 'download').replace(/[^a-z0-9_\-\s]/gi, '').trim().slice(0, 80) || 'download';
}

// ── Helper: detect platform binary path ───────────────────────────────────
function getBin(name) {
  return name;
}

// ── Helper: fetch title using yt-dlp ──────────────────────────────────────
function fetchTitle(url, signal) {
  return new Promise((resolve) => {
    // 1. Ensure getBin('yt-dlp') returns just 'yt-dlp'
    const proc = spawn(getBin('yt-dlp'), ['--get-title', '--no-playlist', url]);
    let title = '';
    let errorOutput = ''; // Added to store errors

    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 20000);

    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        proc.kill();
        resolve(null);
      }, { once: true });
    }

    proc.stdout.on('data', d => (title += d.toString()));

    // 2. Capture stderr instead of ignoring it
    proc.stderr.on('data', (d) => {
      errorOutput += d.toString();
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        // 3. Log the error to the Render dashboard so we can see it
        console.error('yt-dlp failed:', errorOutput);
        resolve(null);
      } else {
        const t = title.trim();
        resolve(t ? t : null);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error('Process error:', err);
      resolve(null);
    });
  });
}

// ── /start endpoint — SSE ─────────────────────────────────────────────────
app.get('/start', rateLimit, async (req, res) => {
  const { url, format, id } = req.query;

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).send('Invalid YouTube URL');
  }
  if (!['mp3', 'mp4'].includes(format)) {
    return res.status(400).send('Invalid format');
  }

  // ── SSE headers ──────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sseEnded = false;
  const send = (data) => {
    if (!sseEnded) {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) { }
    }
  };
  const endSSE = () => {
    if (!sseEnded) { sseEnded = true; res.end(); }
  };

  // AbortController — used to cancel title fetch when client disconnects
  const abortCtrl = new AbortController();
  let clientDisconnected = false;
  let downloadProc = null;

  // ── Client disconnect / cancel ────────────────────────────────────────────
  req.on('close', () => {
    clientDisconnected = true;
    abortCtrl.abort();           // cancel title fetch if still running
    if (downloadProc) downloadProc.kill(); // cancel download if running
  });

  // ── STEP 1: Fetch title ───────────────────────────────────────────────────
  send({ type: 'status', stage: 'Fetching title...' });

  const videoTitle = await fetchTitle(url, abortCtrl.signal);

  // If cancelled during title fetch — just end silently
  if (clientDisconnected) { endSSE(); return; }

  if (!videoTitle) {
    send({ type: 'title_error', message: 'Could not fetch title. Video may be private, age-restricted, or unavailable.' });
    endSSE();
    return;
  }

  send({ type: 'title', title: videoTitle });
  await new Promise(r => setTimeout(r, 300));

  if (clientDisconnected) { endSSE(); return; }

  // ── STEP 2: Start download ────────────────────────────────────────────────
  const ext = format === 'mp3' ? 'mp3' : 'mp4';
  const safeId = String(id).replace(/[^a-z0-9]/gi, '').slice(0, 30) || Date.now().toString();
  const outputPath = path.join(__dirname, `temp_${format}_${safeId}.${ext}`);

  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  let args;
  if (format === 'mp3') {
    args = [
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '--ffmpeg-location', getBin('ffmpeg'),
      '--no-playlist', '--newline',
      '-o', outputPath, url
    ];
  } else {
    args = [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', getBin('ffmpeg'),
      '--no-playlist', '--newline',
      '-o', outputPath, url
    ];
  }

  send({ type: 'progress', percent: 2, stage: 'Starting download...' });

  const proc = spawn(getBin('yt-dlp'), args);
  downloadProc = proc;
  let lastPercent = 2;

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const match = line.match(/(\d+\.?\d*)%/);
      if (match) {
        const pct = Math.min(Math.round(parseFloat(match[1])), 99);
        if (pct > lastPercent) {
          lastPercent = pct;
          let stage = 'Downloading...';
          if (pct >= 95) stage = 'Merging...';
          else if (pct >= 80) stage = 'Converting...';
          else if (pct >= 50) stage = 'Downloading...';
          else stage = 'Buffering...';
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

  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    const timeMatch = line.match(/time=(\d+:\d+:\d+)/);
    if (timeMatch && lastPercent >= 90) {
      lastPercent = Math.min(lastPercent + 1, 99);
      send({ type: 'progress', percent: lastPercent, stage: 'Merging...' });
    }
  });

  proc.on('close', (code) => {
    downloadProc = null;

    // Clean up temp file if cancelled
    if (clientDisconnected) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      return;
    }

    const fileOk = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
    if (code !== 0 || !fileOk) {
      send({ type: 'error', message: 'Download failed. Video may be age-restricted or unavailable.' });
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
      send({ type: 'error', message: 'Failed to read output file.' });
    } finally {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      endSSE();
    }
  });

  proc.on('error', (err) => {
    downloadProc = null;
    if (!clientDisconnected) {
      send({ type: 'error', message: 'Process error: ' + err.message });
      endSSE();
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});


process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});