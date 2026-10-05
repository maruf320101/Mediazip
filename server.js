'use strict';

const express = require('express');
const { spawn, execSync } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const TEMP_DIR     = path.join(__dirname, 'temp_downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// Auto-populate cookies.txt from environment variable (useful on Render/Heroku)
if (process.env.YOUTUBE_COOKIES) {
  try {
    let rawCookies = process.env.YOUTUBE_COOKIES.trim();
    if (rawCookies.length > 20) {
      if (rawCookies.startsWith('IyBOZXRzY2Fw') || (!rawCookies.includes('\n') && !rawCookies.includes('\t'))) {
        try {
          const decoded = Buffer.from(rawCookies, 'base64').toString('utf8');
          if (decoded.includes('# Netscape') || decoded.includes('.youtube.com') || decoded.includes('\t')) {
            rawCookies = decoded;
          }
        } catch {}
      }
      // Only overwrite if it actually contains multiple lines (prevents single-line input corruption)
      if (rawCookies.split('\n').length >= 3) {
        rawCookies = rawCookies.split('\n').map(line => {
          if (line.startsWith('#') || !line.trim()) return line;
          if (!line.includes('\t')) return line.replace(/\s{2,}/g, '\t');
          return line;
        }).join('\n');
        const localExists = fs.existsSync(COOKIES_FILE) && fs.readFileSync(COOKIES_FILE, 'utf8').trim().length > 100;
        if (!localExists) {
          fs.writeFileSync(COOKIES_FILE, rawCookies, 'utf8');
          console.log('[COOKIES] Successfully written cookies.txt from YOUTUBE_COOKIES env.');
        } else {
          console.log('[COOKIES] Valid cookies.txt already present on disk/repo. Preserving it over YOUTUBE_COOKIES env.');
        }
      } else {
        console.warn('[COOKIES] YOUTUBE_COOKIES env variable is single-line or incomplete. Keeping local cookies.txt.');
      }
    }
  } catch (err) {
    console.error('[COOKIES] Error writing cookies from env:', err.message);
  }
}

// Helper: Creates an ephemeral copy of cookies.txt so yt-dlp never strips LOGIN_INFO from the master file
function createTempCookieFile() {
  if (!fs.existsSync(COOKIES_FILE)) return null;
  const tempFile = path.join(TEMP_DIR, `cookie_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`);
  try {
    fs.copyFileSync(COOKIES_FILE, tempFile);
    return tempFile;
  } catch {
    return COOKIES_FILE;
  }
}

/* ── In-memory cache for video info (5 min TTL) ─────────── */
const infoCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(url) {
  const entry = infoCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { infoCache.delete(url); return null; }
  return entry.data;
}
function cacheSet(url, data) {
  infoCache.set(url, { data, ts: Date.now() });
  // Keep cache small: max 20 entries
  if (infoCache.size > 20) {
    const firstKey = infoCache.keys().next().value;
    infoCache.delete(firstKey);
  }
}

/* ── Analytics & Admin Setup ───────────────────────────── */
const analytics = require('./analytics');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '3201012225MaruF@';
const activeAdminTokens = new Set();

function generateAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  activeAdminTokens.add(token);
  return token;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
  if (token && activeAdminTokens.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Invalid or expired session.' });
}

/* ═══════════════════════════════════════════════════════════
   MIDDLEWARE
   ═══════════════════════════════════════════════════════════ */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

/** Detect which platform the URL belongs to */
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url))      return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url))     return 'facebook';
  if (/tiktok\.com/i.test(url))                 return 'tiktok';
  if (/instagram\.com|instagr\.am/i.test(url))  return 'instagram';
  if (/pinterest\.com|pin\.it/i.test(url))      return 'pinterest';
  if (/(?:^|\/\/|\.)(?:twitter|x)\.com|\/\/t\.co\//i.test(url)) return 'twitter';
  if (/reddit\.com|redd\.it/i.test(url))        return 'reddit';
  return 'unknown';
}

/** Convert seconds → human-readable duration */
function fmtDuration(secs) {
  if (!secs) return '--:--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

/** Format view count to human-readable string */
function fmtViews(n) {
  if (!n) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M views`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K views`;
  return `${n} views`;
}

/**
 * Build quality/format options based on platform and
 * actual available formats returned by yt-dlp.
 */
function buildQualities(formats, platform) {
  const qs = [];
  formats = formats || [];

  if (platform === 'youtube') {
    // Collect heights that actually exist in this video
    // Use the real format list: one button per resolution that actually exists.
    // "Resolution" = short side of the frame, so a vertical 1080x1920 Short is 1080p (not 4K).
    const STEPS = [2160, 1440, 1080, 720, 480, 360, 240, 144];
    const LABELS = { 2160: '4K Ultra HD', 1440: '2K QHD', 1080: '1080p Full HD', 720: '720p HD' };
    const hasAudioOnly = formats.some(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');

    const videoFmts = formats
      .filter(f => f.format_id && f.vcodec && f.vcodec !== 'none' && (f.height || f.width) && f.url)
      .map(f => {
        const shortSide = Math.min(f.width || f.height, f.height || f.width);
        const step = STEPS.find(s => shortSide >= s * 0.9) || null; // allow slightly odd sizes (e.g. 1072)
        const isH264 = /^(avc|h264)/i.test(f.vcodec || '');
        const hasAudio = f.acodec && f.acodec !== 'none';
        // Higher score = better pick for this resolution
        const score = (isH264 ? 1000 : 0) + (f.ext === 'mp4' ? 100 : 0) + (hasAudio ? 50 : 0) + (f.fps || 0) + (f.tbr || 0) / 10000;
        return { f, step, score, hasAudio };
      })
      .filter(x => x.step);

    const bestPerStep = new Map();
    videoFmts.forEach(x => {
      const cur = bestPerStep.get(x.step);
      if (!cur || x.score > cur.score) bestPerStep.set(x.step, x);
    });

    let bestAdded = false;
    STEPS.filter(s => s >= 360 && bestPerStep.has(s)).forEach(step => {
      const { f, hasAudio } = bestPerStep.get(step);
      const id = f.format_id;
      const fallback = `bestvideo[height<=${step}]+bestaudio/best[height<=${step}]`;
      const format = hasAudio
        ? `${id}/${fallback}`
        : (hasAudioOnly ? `${id}+bestaudio[ext=m4a]/${id}+bestaudio/${fallback}` : `${id}/${fallback}`);
      const isBest = !bestAdded;
      bestAdded = true;
      qs.push({ type: 'video', label: LABELS[step] || `${step}p`, height: step, format, ext: 'mp4', best: isBest });
    });

    // Safety fallback: if nothing was detected
    if (qs.length === 0) {
      qs.push({ type:'video', label:'Best Quality', format:'bestvideo+bestaudio/best', ext:'mp4', best:true });
    }

  } else if (platform === 'facebook') {
    qs.push(
      { type:'video', label:'HD Quality', format:'best[height>=720][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/bestvideo[vcodec!=none]+bestaudio[acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true  },
      { type:'video', label:'SD Quality', format:'best[height<=540][vcodec!=none][acodec!=none]/worst[vcodec!=none][acodec!=none]/bestvideo[height<=540][vcodec!=none]+bestaudio[acodec!=none]/worst[vcodec!=none]', ext:'mp4', best:false }
    );

  } else if (platform === 'tiktok') {
    // Prioritize H.264 (AVC) so video plays natively on all Windows/Mac/Phones without requiring paid HEVC extensions
    qs.push(
      { type:'video', label:'Original HD (No Watermark)', format:'play/best[vcodec^=h264][acodec!=none]/best[vcodec^=avc][acodec!=none]/best[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true, nowatermark:true },
      { type:'video', label:'Standard Quality', format:'h264_540p_492879-0/best[height<=540][vcodec^=h264]/worst[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:false }
    );

  } else if (platform === 'instagram') {
    qs.push(
      { type:'video', label:'Original Quality (HD)', format:'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true },
      { type:'video', label:'Standard Quality',      format:'worst[ext=mp4][vcodec!=none][acodec!=none]/worst[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:false }
    );

  } else if (platform === 'pinterest') {
    qs.push(
      { type:'video', label:'Original HD Video', format:'best[vcodec!=none][acodec!=none]/bestvideo+bestaudio/best[vcodec!=none]', ext:'mp4', best:true }
    );

  } else if (platform === 'twitter') {
    qs.push(
      { type:'video', label:'Original Quality (HD)', format:'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/bestvideo[vcodec!=none]+bestaudio[acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true },
      { type:'video', label:'Standard Quality',      format:'worst[ext=mp4][vcodec!=none][acodec!=none]/worst[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:false }
    );

  } else if (platform === 'reddit') {
    // Reddit serves video and audio separately (DASH), merge them with ffmpeg
    qs.push(
      { type:'video', label:'Best Quality (with Sound)', format:'bestvideo[vcodec!=none]+bestaudio[acodec!=none]/best[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true  },
      { type:'video', label:'720p',                      format:'bestvideo[height<=720][vcodec!=none]+bestaudio[acodec!=none]/best[height<=720][vcodec!=none]/best[vcodec!=none]', ext:'mp4', best:false },
      { type:'video', label:'480p',                      format:'bestvideo[height<=480][vcodec!=none]+bestaudio[acodec!=none]/best[height<=480][vcodec!=none]/best[vcodec!=none]', ext:'mp4', best:false }
    );

  } else {
    qs.push(
      { type:'video', label:'Best Quality', format:'bestvideo[vcodec!=none]+bestaudio[acodec!=none]/best[vcodec!=none][acodec!=none]/best[vcodec!=none]', ext:'mp4', best:true }
    );
  }

  // Audio options (available for all platforms)
  qs.push(
    { type:'audio', label:'MP3 320kbps', audioQuality:'0', ext:'mp3' },
    { type:'audio', label:'MP3 128kbps', audioQuality:'5', ext:'mp3' }
  );

  // Animated GIF options (available for all platforms)
  qs.push(
    { type:'gif', label:'High Quality GIF (10s)', ext:'gif', gifWidth: 480, gifFps: 14, gifDuration: 10, best: true },
    { type:'gif', label:'Compact GIF (5s)',      ext:'gif', gifWidth: 320, gifFps: 10, gifDuration: 5,  best: false }
  );

  return qs;
}

/** Sanitize a string to be safe for use in filenames */
function safeFilename(str, maxLen = 80) {
  return (str || 'MediaZip')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'MediaZip';
}

/* ═══════════════════════════════════════════════════════════
   ROUTE: Health check & lightweight ping
   ═══════════════════════════════════════════════════════════ */
app.get('/api/ping', (req, res) => res.status(200).send('pong'));
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('/google52fb15872f78caa2.html', (req, res) => res.type('text/html').send('google-site-verification: google52fb15872f78caa2.html'));
app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'favicon.svg')));

app.get('/api/check', (req, res) => {
  try {
    const version = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 5000 }).trim();
    res.json({ ok: true, version });
  } catch {
    res.json({ ok: false, version: null });
  }
});

/* ── Render 24/7 Keep-Alive Auto-Pinger ──────────────────── */
const APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://mediazip.onrender.com';
const PING_INTERVAL = 13 * 60 * 1000; // Ping every 13 minutes (Render sleeps after 15m)

function pingSelf() {
  if (!APP_URL || APP_URL.includes('localhost')) return;
  const pingUrl = `${APP_URL.replace(/\/$/, '')}/api/ping`;
  const client = pingUrl.startsWith('https') ? require('https') : require('http');

  client.get(pingUrl, (res) => {
    console.log(`[KEEP-ALIVE] Self-ping OK (${res.statusCode}) at ${new Date().toLocaleTimeString()}`);
  }).on('error', (err) => {
    console.warn(`[KEEP-ALIVE] Self-ping notice:`, err.message);
  });
}

// Start keep-alive loop after initial 15 seconds
setTimeout(() => {
  pingSelf();
  setInterval(pingSelf, PING_INTERVAL);
}, 15000);

/* ═══════════════════════════════════════════════════════════
   ADMIN & ANALYTICS API ROUTES
   ═══════════════════════════════════════════════════════════ */
app.post('/api/track-visit', (req, res) => {
  analytics.recordVisit();
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect admin password.' });
  }
  const token = generateAdminToken();
  res.json({ ok: true, token });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  res.json(analytics.getAnalytics());
});

app.post('/api/admin/clear-logs', requireAdmin, (req, res) => {
  analytics.clearRecentLogs();
  res.json({ ok: true, message: 'Recent download logs cleared.' });
});

/* ── YouTube & Cookies Admin Management ─────────────────── */
app.get('/api/admin/cookies-status', requireAdmin, (req, res) => {
  const exists = fs.existsSync(COOKIES_FILE);
  let size = 0;
  let lastModified = null;
  let lineCount = 0;
  if (exists) {
    try {
      const stat = fs.statSync(COOKIES_FILE);
      size = stat.size;
      lastModified = stat.mtime;
      const content = fs.readFileSync(COOKIES_FILE, 'utf8');
      lineCount = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    } catch {}
  }
  res.json({ exists, size, lastModified, lineCount });
});

app.post('/api/admin/save-cookies', requireAdmin, (req, res) => {
  const { cookies } = req.body || {};
  if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
    return res.status(400).json({ error: 'Please paste valid cookies in Netscape format.' });
  }

  try {
    let normalized = cookies.trim().split('\n').map(line => {
      if (line.startsWith('#') || !line.trim()) return line;
      if (!line.includes('\t')) return line.replace(/\s{2,}/g, '\t');
      return line;
    }).join('\n');

    fs.writeFileSync(COOKIES_FILE, normalized, 'utf8');
    const stat = fs.statSync(COOKIES_FILE);
    console.log(`[COOKIES] Admin saved cookies.txt (${stat.size} bytes)`);
    res.json({ ok: true, message: `Cookies saved successfully! (${stat.size} bytes)` });
  } catch (err) {
    console.error('[COOKIES] Failed to save cookies:', err.message);
    res.status(500).json({ error: 'Failed to write cookies.txt: ' + err.message });
  }
});

app.post('/api/admin/delete-cookies', requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      fs.unlinkSync(COOKIES_FILE);
    }
    console.log('[COOKIES] Admin deleted cookies.txt');
    res.json({ ok: true, message: 'Cookies file deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete cookies: ' + err.message });
  }
});

app.post('/api/admin/test-youtube', requireAdmin, (req, res) => {
  const testUrl = req.body && req.body.url ? req.body.url.trim() : 'https://youtube.com/shorts/MC-wJZctqkg';
  console.log(`[TEST] Testing YouTube URL via admin: ${testUrl}`);

  const testArgs = [
    '--dump-json',
    '--no-playlist',
    '--playlist-items', '1',
    '--no-warnings',
    '--no-check-certificate',
    '--no-check-formats',
    '--skip-download',
    '--socket-timeout', '15',
    '--remote-components', 'ejs:github',
    '--js-runtimes', 'deno',
    '-f', 'b/bestvideo+bestaudio/best',
  ];
  const tempCookie = createTempCookieFile();
  if (tempCookie) {
    testArgs.push('--cookies', tempCookie);
    testArgs.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  } else {
    testArgs.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  }
  testArgs.push(testUrl);

  const proc = spawn('yt-dlp', testArgs);
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const cleanupCookie = () => {
    if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
  };

  proc.on('close', code => {
    cleanupCookie();
    if (code !== 0) {
      return res.json({
        success: false,
        code,
        error: stderr.trim() || 'yt-dlp failed to fetch video',
        cookiesLoaded: fs.existsSync(COOKIES_FILE)
      });
    }

    try {
      const rawLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
      const data = JSON.parse(rawLine);
      return res.json({
        success: true,
        title: data.title || 'Untitled',
        uploader: data.uploader || 'Unknown',
        duration: data.duration || 0,
        formatsCount: (data.formats || []).length,
        cookiesLoaded: fs.existsSync(COOKIES_FILE)
      });
    } catch (e) {
      return res.json({ success: false, error: 'Could not parse output JSON', raw: stdout.slice(0, 200) });
    }
  });

  proc.on('error', err => {
    res.json({ success: false, error: 'Failed to launch yt-dlp: ' + err.message });
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ═══════════════════════════════════════════════════════════
   DIAGNOSTIC ROUTE: Live Cloud Server & YouTube Diagnostics
   GET /api/diagnose?url=<optional_url>
   ═══════════════════════════════════════════════════════════ */
app.get('/api/diagnose', async (req, res) => {
  const testUrl = req.query.url || 'https://youtube.com/shorts/MC-wJZctqkg?si=umXayiqa34ReX3Qu';
  
  // 1. Fetch server public IP
  let serverIp = 'Unknown';
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    const ipData = await ipRes.json();
    serverIp = ipData.ip || 'Unknown';
  } catch (e) {
    serverIp = 'Error fetching IP: ' + e.message;
  }

  // 2. Check cookies
  const cookiesExist = fs.existsSync(COOKIES_FILE);
  let cookiesSize = 0;
  let cookiesLines = 0;
  if (cookiesExist) {
    try {
      const stat = fs.statSync(COOKIES_FILE);
      cookiesSize = stat.size;
      const content = fs.readFileSync(COOKIES_FILE, 'utf8');
      cookiesLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    } catch {}
  }

  // 3. Run yt-dlp -v test
  const testArgs = [
    '-v',
    '--dump-json',
    '--no-playlist',
    '--playlist-items', '1',
    '--no-check-certificate',
    '--no-check-formats',
    '--skip-download',
    '--socket-timeout', '15',
    '--remote-components', 'ejs:github',
    '--js-runtimes', 'deno',
    '-f', 'b/bestvideo+bestaudio/best',
  ];
  const tempCookie = createTempCookieFile();
  if (tempCookie) {
    testArgs.push('--cookies', tempCookie);
    testArgs.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  } else {
    testArgs.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  }
  if (process.env.YOUTUBE_PROXY) {
    testArgs.push('--proxy', process.env.YOUTUBE_PROXY);
  }
  testArgs.push(testUrl);

  const tStart = Date.now();
  const proc = spawn('yt-dlp', testArgs);
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const cleanupCookie = () => {
    if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
  };

  proc.on('close', code => {
    cleanupCookie();
    const durationMs = Date.now() - tStart;
    let parsed = null;
    try {
      const line = stdout.trim().split('\n').find(l => l.startsWith('{'));
      if (line) parsed = JSON.parse(line);
    } catch {}

    // Check if JSON format requested
    if (req.headers.accept && req.headers.accept.includes('application/json') && !req.query.html) {
      return res.json({
        serverIp,
        cookiesExist,
        cookiesSize,
        cookiesLines,
        code,
        durationMs,
        success: code === 0,
        parsedTitle: parsed ? parsed.title : null,
        parsedFormatsCount: parsed && parsed.formats ? parsed.formats.length : 0,
        stderr: stderr.slice(-3000),
      });
    }

    // Otherwise render high-visibility diagnostic HTML page
    const isBotError = /Sign in to confirm you're not a bot/i.test(stderr);
    const isFormatError = /Requested format is not available/i.test(stderr);
    const isSuccess = code === 0 && parsed;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>MediaZip - Live Server Diagnostics</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 30px; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 24px; border: 1px solid #334155; }
    h1 { margin-top: 0; font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; }
    .badge.green { background: #059669; color: #fff; }
    .badge.red { background: #dc2626; color: #fff; }
    .badge.amber { background: #d97706; color: #fff; }
    .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin: 20px 0; }
    .kpi-box { background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid #334155; }
    .kpi-label { font-size: 0.78rem; color: #94a3b8; text-transform: uppercase; }
    .kpi-val { font-size: 1.15rem; font-weight: 700; margin-top: 4px; color: #38bdf8; word-break: break-all; }
    .terminal { background: #000; border: 1px solid #334155; border-radius: 8px; padding: 14px; font-family: monospace; font-size: 0.82rem; color: #a7f3d0; white-space: pre-wrap; max-height: 350px; overflow-y: auto; }
    .terminal.err { color: #fca5a5; }
    .guide-card { background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 16px; margin-top: 20px; }
    .btn { background: #0284c7; color: #fff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-weight: 600; display: inline-block; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <span>🔍 MediaZip Cloud Diagnostics</span>
      <span class="badge ${isSuccess ? 'green' : 'red'}">${isSuccess ? 'PASS' : 'FAIL'} (Code ${code})</span>
    </h1>

    <div class="kpi-row">
      <div class="kpi-box">
        <div class="kpi-label">Server Public IP</div>
        <div class="kpi-val">${serverIp}</div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">cookies.txt Status</div>
        <div class="kpi-val" style="color: ${cookiesExist ? '#34d399' : '#f87171'}">
          ${cookiesExist ? 'Active (' + cookiesLines + ' lines, ' + (cookiesSize/1024).toFixed(1) + ' KB)' : 'Not Found (Missing)'}
        </div>
      </div>
      <div class="kpi-box">
        <div class="kpi-label">Test Duration</div>
        <div class="kpi-val">${durationMs} ms</div>
      </div>
    </div>

    <h3>Target Test URL:</h3>
    <p style="color: #94a3b8; word-break: break-all;"><code>${testUrl}</code></p>

    ${isSuccess ? `
    <div style="background: rgba(5,150,105,0.15); border: 1px solid #059669; padding: 14px; border-radius: 8px; margin: 16px 0;">
      <h3 style="color: #34d399; margin: 0 0 8px 0;">✅ SUCCESS: Video Successfully Extracted!</h3>
      <p style="margin: 0;"><strong>Title:</strong> ${parsed.title}</p>
      <p style="margin: 4px 0;"><strong>Channel:</strong> ${parsed.uploader || 'Unknown'}</p>
      <p style="margin: 4px 0;"><strong>Available Formats:</strong> ${parsed.formats ? parsed.formats.length : 0}</p>
    </div>` : `
    <div style="background: rgba(220,38,38,0.15); border: 1px solid #dc2626; padding: 14px; border-radius: 8px; margin: 16px 0;">
      <h3 style="color: #f87171; margin: 0 0 8px 0;">❌ FAILED: ${isBotError ? 'YouTube Bot Check Triggered by Datacenter IP' : (isFormatError ? 'Format Not Available' : 'yt-dlp Execution Error')}</h3>
      <p style="margin: 0; font-size: 0.9rem;">
        ${isBotError 
          ? 'YouTube detected that requests are coming from a cloud hosting IP (' + serverIp + ') and demands cookie verification.'
          : 'Check the terminal log below for the exact stderr message.'}
      </p>
    </div>`}

    <h3>Raw Terminal Stderr Output (yt-dlp -v):</h3>
    <div class="terminal ${isSuccess ? '' : 'err'}">${(stderr || stdout || 'No output recorded.').replace(/</g, '&lt;')}</div>

    <div class="guide-card">
      <h3 style="margin-top:0; color: #38bdf8;">🛠️ How to Resolve This:</h3>
      <ol style="margin-left: 20px; font-size: 0.9rem;">
        <li>Go to your Admin Panel: <a href="/admin" class="btn" style="padding: 4px 10px; font-size: 0.8rem; margin: 0 4px;">Open /admin</a></li>
        <li>Login with your admin password.</li>
        <li>Use Chrome extension <strong>"Get cookies.txt LOCALLY"</strong> on <code>youtube.com</code>, copy cookies, paste into the box, and click <strong>Save Cookies</strong>.</li>
        <li>Once cookies are saved, refresh this page (<code>/api/diagnose</code>) to see the status turn <strong>PASS (GREEN)</strong>!</li>
      </ol>
    </div>
  </div>
</body>
</html>`);
  });

  proc.on('error', err => {
    res.status(500).send('Failed to launch yt-dlp: ' + err.message);
  });
});

/* ═══════════════════════════════════════════════════════════
   ROUTE: Fetch video metadata
   GET /api/info?url=<video_url>
   ═══════════════════════════════════════════════════════════ */
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL parameter is required.' });

  // ── Cache hit → instant response ─────────────────────────
  const cached = cacheGet(url);
  if (cached) {
    console.log(`[INFO] Cache hit → "${cached.title}"`);
    return res.json(cached);
  }

  console.log(`[INFO] Fetching: ${url}`);
  const t0 = Date.now();

  const args = [
    '--dump-json',
    '--no-playlist',
    '--playlist-items', '1',   // posts with several videos: first one only
    '--no-warnings',
    '--no-check-certificate',
    '--no-check-formats',          // ⚡ Skip format availability check (saves 2-5s)
    '--skip-download',             // ⚡ Don't download anything, just metadata
    '--socket-timeout', '20',
    '--retries', '2',
    '--remote-components', 'ejs:github', // ⚡ Solves YouTube signature/JS challenges
    '--js-runtimes', 'deno',              // ⚡ Explicitly use Deno runtime for JS challenges on cloud Linux
    '-S', 'vcodec:h264,res,acodec:m4a',   // ⚡ Prioritize H.264 for universal Windows/Mac/iOS/Android playback
    '-f', 'b/bestvideo+bestaudio/best',
  ];
  const tempCookie = createTempCookieFile();
  if (tempCookie) {
    args.push('--cookies', tempCookie);
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  } else {
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  }
  if (process.env.YOUTUBE_PROXY && url.includes('youtu')) {
    args.push('--proxy', process.env.YOUTUBE_PROXY);
  }
  args.push(url);

  const ytdlp = spawn('yt-dlp', args);

  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', chunk => { stdout += chunk.toString(); });
  ytdlp.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const cleanupCookie = () => {
    if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
  };

  ytdlp.on('close', code => {
    cleanupCookie();
    if (code !== 0) {
      console.error(`[INFO] yt-dlp exited ${code}:`, stderr.slice(0, 300));
      let msg = 'Failed to fetch video info. Please check the URL and try again.';
      if (/Instagram API|empty media response/i.test(stderr)) msg = 'Instagram requires login cookies. Please add cookies.txt to project folder.';
      if (/Unsupported URL/i.test(stderr))  msg = 'Unsupported URL. Use a YouTube, Facebook, TikTok, Instagram, Pinterest, Twitter (X) or Reddit link.';
      if (/No video could be found|no video formats|does not contain any video/i.test(stderr)) msg = 'No video found in this post. Make sure the link points to a post that contains a video.';
      if (/Private video/i.test(stderr))    msg = 'This video is private and cannot be downloaded.';
      if (/not available/i.test(stderr))    msg = 'Video not available (removed, private, or region-restricted).';
      if (/age.restrict/i.test(stderr))     msg = 'Age-restricted video: cannot download without login.';
      if (/Sign in to confirm you're not a bot/i.test(stderr)) msg = 'YouTube security check triggered by cloud IP. Please add cookies in Admin Panel (/admin) to enable YouTube downloads.';
      else if (/Sign in/i.test(stderr))     msg = 'This video requires login or is private. Only public videos are supported.';
      return res.status(400).json({ error: msg });
    }

    try {
      const rawLine = stdout.trim().split('\n').find(l => l.startsWith('{'));
      if (!rawLine) throw new Error('No JSON output from yt-dlp');

      const info     = JSON.parse(rawLine);
      const platform = detectPlatform(url);

      // Pick best thumbnail (highest resolution)
      let thumbnail = info.thumbnail || '';
      if (!thumbnail && Array.isArray(info.thumbnails) && info.thumbnails.length) {
        const sorted = [...info.thumbnails].sort((a,b) => (b.width||0)-(a.width||0));
        thumbnail = sorted[0].url || '';
      }

      // Find playable stream or embed for Watch Preview
      let streamUrl = '';
      let embedUrl  = '';

      if (platform === 'youtube') {
        const vidId = info.id || info.display_id || '';
        if (vidId) {
          embedUrl = `https://www.youtube-nocookie.com/embed/${vidId}?autoplay=1&enablejsapi=1`;
        }
      }

      if (Array.isArray(info.formats) && info.formats.length > 0) {
        // Priority 1: Check for master HLS manifest (e.g. Pinterest, Twitch)
        const masterHls = info.formats.find(f => f.manifest_url && f.manifest_url.includes('.m3u8'));
        if (masterHls) {
          streamUrl = masterHls.manifest_url;
        }

        // Priority 2: Progressive MP4 format with both video and audio
        if (!streamUrl) {
          const prog = info.formats
            .filter(f => f.url && f.ext === 'mp4' && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          if (prog.length > 0) streamUrl = prog[0].url;
        }

        // Priority 3: Any format with both audio & video
        if (!streamUrl) {
          const anyDual = info.formats.find(f => f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
          if (anyDual) streamUrl = anyDual.url;
        }

        // Priority 4: Direct info.url if video
        if (!streamUrl && info.url && (!info.ext || info.ext === 'mp4' || info.ext === 'webm')) {
          streamUrl = info.url;
        }

        // Priority 5: Any format with video
        if (!streamUrl) {
          const anyVideo = info.formats
            .filter(f => f.url && f.vcodec && f.vcodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          if (anyVideo.length > 0) streamUrl = anyVideo[0].url;
        }
      } else if (info.url) {
        streamUrl = info.url;
      }

      const response = {
        id:        info.id || info.display_id || '',
        title:     info.title    || 'Untitled Video',
        thumbnail,
        duration:  fmtDuration(info.duration),
        uploader:  info.uploader || info.channel || info.creator || info.uploader_id || 'Unknown',
        views:     fmtViews(info.view_count),
        platform,
        streamUrl,
        embedUrl,
        qualities: buildQualities(info.formats || [], platform),
      };

      // Store in cache
      cacheSet(url, response);

      console.log(`[INFO] OK in ${Date.now()-t0}ms → "${response.title}" (${platform})`);
      res.json(response);
    } catch(e) {
      console.error('[INFO] Parse error:', e.message);
      res.status(500).json({ error: 'Could not parse video information.' });
    }
  });

  ytdlp.on('error', err => {
    cleanupCookie();
    console.error('[INFO] Spawn error:', err.message);
    res.status(500).json({ error: 'yt-dlp not found. Please run install.bat first.' });
  });
});

/* ═══════════════════════════════════════════════════════════
   ROUTE: Local Preview Video (Caches & streams 100% locally)
   GET /api/preview-video?url=
   ═══════════════════════════════════════════════════════════ */
app.get('/api/preview-video', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required.');

  // Create deterministic hash filename for preview
  const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
  const previewPath = path.join(TEMP_DIR, `preview_${urlHash}.mp4`);

  const streamFile = (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4',
          'Access-Control-Allow-Origin': '*',
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
      }
    } catch(err) {
      console.error('[PREVIEW] Stream error:', err.message);
      if (!res.headersSent) res.status(500).send('Could not stream preview.');
    }
  };

  // If already downloaded and valid (> 5KB), stream it immediately
  if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 5120) {
    return streamFile(previewPath);
  }

  console.log(`[PREVIEW] Generating local preview for: ${url}`);

  const args = [
    '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--playlist-items', '1',   // posts with several videos: first one only
    '--no-warnings',
    '--no-check-certificate',
    '--no-check-formats',
    '--socket-timeout', '20',
    '--remote-components', 'ejs:github',
    '--js-runtimes', 'deno',
    '-S', 'vcodec:h264,res,acodec:m4a',
    '-o', previewPath,
  ];
  const tempCookie = createTempCookieFile();
  if (tempCookie) {
    args.push('--cookies', tempCookie);
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  } else {
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  }
  args.push(url);

  const proc = spawn('yt-dlp', args);

  const cleanupCookie = () => {
    if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
  };

  proc.on('close', (code) => {
    cleanupCookie();
    if (code === 0 && fs.existsSync(previewPath)) {
      console.log(`[PREVIEW] Ready: "${path.basename(previewPath)}" (${(fs.statSync(previewPath).size / 1024 / 1024).toFixed(2)} MB)`);
      return streamFile(previewPath);
    } else {
      console.error(`[PREVIEW] Failed with code ${code}`);
      if (!res.headersSent) res.status(500).send('Preview generation failed.');
    }
  });

  proc.on('error', (err) => {
    cleanupCookie();
    console.error('[PREVIEW] Spawn error:', err.message);
    if (!res.headersSent) res.status(500).send('Failed to launch preview process.');
  });
});

/* ═══════════════════════════════════════════════════════════
   ROUTE: Stream Proxy for video preview (bypasses CORS/hotlink)
   GET /api/proxy-video?url=
   ═══════════════════════════════════════════════════════════ */
app.get('/api/proxy-video', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required.');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstream = await fetch(url, { headers });

    if (upstream.headers.get('content-range')) {
      res.setHeader('Content-Range', upstream.headers.get('content-range'));
      res.status(206);
    } else {
      res.status(upstream.status);
    }

    const cType = upstream.headers.get('content-type') || 'video/mp4';
    const cLen  = upstream.headers.get('content-length');

    res.setHeader('Content-Type', cType);
    if (cLen) res.setHeader('Content-Length', cLen);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!upstream.body) {
      return res.end();
    }

    const reader = upstream.body.getReader();
    req.on('close', () => {
      try { reader.cancel(); } catch {}
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    console.error('[PROXY-VIDEO] Error:', err.message);
    if (!res.headersSent) res.status(500).send('Could not proxy media stream.');
  }
});

/* ═══════════════════════════════════════════════════════════
   ROUTE: Stream video/audio download
   GET /api/download?url=&format=&ext=&label=&type=&audioQuality=
   ═══════════════════════════════════════════════════════════ */
app.get('/api/download', (req, res) => {
  const { url, format, ext, label, type, audioQuality } = req.query;

  if (!url) return res.status(400).json({ error: 'URL required.' });

  const fileExt  = ext  || 'mp4';
  const filename = `${safeFilename(label)}.${fileExt}`;

  // Record download in analytics
  const platform = detectPlatform(url);
  analytics.recordDownload({
    platform,
    title: label || 'MediaZip Video',
    type: type || 'video',
    ext: fileExt,
  });

  console.log(`[DOWNLOAD] Starting: "${filename}" | platform=${platform} | type=${type || 'video'}`);

  // ── Handle GIF Generation ─────────────────────────────────
  if (type === 'gif') {
    const gifFilename = `${safeFilename(label)}.gif`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(gifFilename)}`);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const duration = parseInt(req.query.gifDuration, 10) || 10;
    const width    = parseInt(req.query.gifWidth, 10) || 480;
    const fps      = parseInt(req.query.gifFps, 10) || 12;

    const urlHash     = crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
    const previewFile = path.join(TEMP_DIR, `preview_${urlHash}.mp4`);

    const convertToGif = (inputSource) => {
      const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
      const ffmpegArgs = [
        '-y',
        '-i', inputSource,
        '-t', String(duration),
        '-vf', vf,
        '-f', 'gif',
        '-',
      ];
      const ff = spawn('ffmpeg', ffmpegArgs);
      ff.stdout.pipe(res);
      ff.stderr.on('data', () => {});
      req.on('close', () => {
        try { ff.kill(); } catch {}
      });
      return ff;
    };

    // If local mp4 already exists from preview, convert directly
    if (fs.existsSync(previewFile) && fs.statSync(previewFile).size > 5120) {
      console.log(`[GIF] Converting cached MP4: "${previewFile}" (${duration}s, ${width}px)`);
      convertToGif(previewFile);
      return;
    }

    // Otherwise download a quick clip, convert to gif, and clean up
    console.log(`[GIF] Downloading clip for GIF generation: ${url}`);
    const tempClip = path.join(TEMP_DIR, `temp_clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`);
    const dlArgs = [
      '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--playlist-items', '1',   // posts with several videos: first one only
      '--no-warnings',
      '--no-check-certificate',
      '--no-check-formats',
      '--socket-timeout', '25',
      '-o', tempClip,
    ];
    const tempCookie = createTempCookieFile();
    if (tempCookie) dlArgs.push('--cookies', tempCookie);
    dlArgs.push(url);

    const proc = spawn('yt-dlp', dlArgs);
    const cleanupCookie = () => {
      if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
    };

    req.on('close', () => {
      cleanupCookie();
      try { proc.kill(); } catch {}
    });

    proc.on('close', (code) => {
      cleanupCookie();
      if (code === 0 && fs.existsSync(tempClip)) {
        const ff = convertToGif(tempClip);
        ff.on('close', () => {
          fs.unlink(tempClip, () => {});
        });
      } else {
        if (!res.headersSent) res.status(500).send('GIF generation failed.');
        fs.unlink(tempClip, () => {});
      }
    });

    proc.on('error', (err) => {
      cleanupCookie();
      console.error('[GIF] yt-dlp error:', err.message);
      if (!res.headersSent) res.status(500).send('yt-dlp spawn failed.');
    });

    return;
  }

  // Build yt-dlp arguments (optimized for speed)
  // Handle Audio vs Video Downloads
  if (type === 'audio') {
    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', audioQuality || '0',
      '--no-playlist',
      '--playlist-items', '1',
      '--no-warnings',
      '--no-check-certificate',
      '--no-check-formats',
      '--concurrent-fragments', '4',
      '--socket-timeout', '60',
      '--remote-components', 'ejs:github',
      '--js-runtimes', 'deno',
    ];

    const tempCookie = createTempCookieFile();
    if (tempCookie) {
      args.push('--cookies', tempCookie);
      args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
    } else {
      args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
    }

    if (process.env.YOUTUBE_PROXY && url.includes('youtu')) {
      args.push('--proxy', process.env.YOUTUBE_PROXY);
    }

    args.push('-o', '-');
    args.push(url);

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const ytdlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let audioStderr = '';
    const cleanupCookie = () => {
      if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
    };

    ytdlp.stdout.pipe(res);
    ytdlp.stderr.on('data', chunk => {
      audioStderr += chunk.toString();
      const line = chunk.toString().trim();
      if (line && line.includes('%')) process.stderr.write(`\r[yt-dlp audio] ${line}`);
    });
    ytdlp.on('close', code => {
      cleanupCookie();
      if (code !== 0) {
        console.error(`\n[DOWNLOAD AUDIO] Failed (code ${code}):`, audioStderr.slice(-400));
      } else {
        console.log(`\n[DOWNLOAD AUDIO] Done (code ${code}) | "${filename}"`);
      }
    });
    ytdlp.on('error', err => {
      cleanupCookie();
      console.error('[DOWNLOAD AUDIO] Spawn error:', err.message);
      if (!res.headersSent) res.status(500).end('Audio download failed.');
    });
    res.on('close', () => {
      cleanupCookie();
      ytdlp.kill('SIGTERM');
    });
    return;
  }

  // Video Download: Save to temp file to ensure ffmpeg properly merges video and audio tracks
  const fmtStr = (format || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best').replace(/\s+/g, '+');
  const tempDownloadFile = path.join(TEMP_DIR, `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${fileExt}`);

  const args = [
    '-f', fmtStr,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--playlist-items', '1',
    '--no-warnings',
    '--no-check-certificate',
    '--no-check-formats',
    '--concurrent-fragments', '4',
    '--http-chunk-size', '10M',
    '--socket-timeout', '60',
    '--remote-components', 'ejs:github',
    '--js-runtimes', 'deno',
    '-S', 'vcodec:h264,res,acodec:m4a',
  ];

  const tempCookie = createTempCookieFile();
  if (tempCookie) {
    args.push('--cookies', tempCookie);
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  } else {
    args.push('--extractor-args', 'youtube:player_client=web_embedded,android,web;skip=translated_subs');
  }

  if (process.env.YOUTUBE_PROXY && url.includes('youtu')) {
    args.push('--proxy', process.env.YOUTUBE_PROXY);
  }

  args.push('-o', tempDownloadFile);
  args.push(url);

  let videoStderr = '';
  const ytdlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanupCookie = () => {
    if (tempCookie && tempCookie !== COOKIES_FILE) fs.unlink(tempCookie, () => {});
  };

  req.on('close', () => {
    cleanupCookie();
    try { ytdlp.kill('SIGTERM'); } catch {}
    fs.unlink(tempDownloadFile, () => {});
  });

  ytdlp.stderr.on('data', chunk => {
    videoStderr += chunk.toString();
    const line = chunk.toString().trim();
    if (line && line.includes('%')) process.stderr.write(`\r[yt-dlp video] ${line}`);
  });

  ytdlp.on('close', code => {
    cleanupCookie();
    if (code === 0 && fs.existsSync(tempDownloadFile)) {
      try {
        const stat = fs.statSync(tempDownloadFile);
        console.log(`\n[DOWNLOAD VIDEO] Done (${(stat.size / 1024 / 1024).toFixed(2)} MB) | "${filename}"`);

        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');

        const readStream = fs.createReadStream(tempDownloadFile);
        readStream.pipe(res);
        readStream.on('close', () => {
          fs.unlink(tempDownloadFile, () => {});
        });
        readStream.on('error', () => {
          fs.unlink(tempDownloadFile, () => {});
        });
      } catch (err) {
        console.error('[DOWNLOAD VIDEO] Stream error:', err.message);
        if (!res.headersSent) res.status(500).send('Error delivering video file.');
        fs.unlink(tempDownloadFile, () => {});
      }
    } else {
      console.error(`\n[DOWNLOAD VIDEO] Failed with code ${code}. Stderr:`, videoStderr.slice(-400));
      if (!res.headersSent) res.status(500).send('Video processing failed.');
      fs.unlink(tempDownloadFile, () => {});
    }
  });

  ytdlp.on('error', err => {
    cleanupCookie();
    console.error('[DOWNLOAD VIDEO] Spawn error:', err.message);
    if (!res.headersSent) res.status(500).end('Download failed: yt-dlp not found.');
    fs.unlink(tempDownloadFile, () => {});
  });
});




/* ═══════════════════════════════════════════════════════════
   ROUTE: Serve SPA for all other routes
   ═══════════════════════════════════════════════════════════ */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ═══════════════════════════════════════════════════════════
   START SERVER
   ═══════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║                                          ║');
  console.log('  ║   ⚡  MediaZip Server: RUNNING           ║');
  console.log(`  ║   🌐  http://localhost:${PORT}               ║`);
  console.log('  ║                                          ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  // Check yt-dlp availability
  try {
    const ver = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 3000 }).trim();
    console.log(`  ✅  yt-dlp v${ver}: Ready!`);
  } catch {
    console.warn('  ⚠️   yt-dlp NOT detected!');
    console.warn('  👉  Please run: pip install yt-dlp');
    console.warn('  👉  Or download from: https://github.com/yt-dlp/yt-dlp/releases');
  }

  // Check ffmpeg
  try {
    execSync('ffmpeg -version', { stdio: 'ignore', timeout: 3000 });
    console.log('  ✅  ffmpeg: Ready! (HD merging supported)');
  } catch {
    console.warn('  ⚠️   ffmpeg NOT detected! HD (1080p+) merging may fail.');
    console.warn('  👉  Download ffmpeg: https://ffmpeg.org/download.html');
  }

  console.log('');
});
