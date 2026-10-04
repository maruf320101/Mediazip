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
    const availHeights = new Set(
      formats
        .filter(f => f.height && f.vcodec && f.vcodec !== 'none')
        .map(f => f.height)
    );

    const targets = [
      { h: 2160, label: '4K Ultra HD' },
      { h: 1440, label: '2K QHD'      },
      { h: 1080, label: '1080p Full HD'},
      { h: 720,  label: '720p HD'     },
      { h: 480,  label: '480p'        },
      { h: 360,  label: '360p'        },
    ];

    let bestAdded = false;
    targets.forEach(({ h, label }) => {
      // If we know the available heights, only show what's available
      if (availHeights.size > 0 && !Array.from(availHeights).some(ah => ah >= h)) return;

      const isBest = !bestAdded;
      if (isBest) bestAdded = true;

      qs.push({
        type:   'video',
        label,
        height: h,
        format: `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]/best`,
        ext:    'mp4',
        best:   isBest,
      });
    });

    // Safety fallback: if nothing was added
    if (qs.length === 0) {
      qs.push(
        { type:'video', label:'1080p Full HD', format:'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best', ext:'mp4', best:true  },
        { type:'video', label:'720p HD',       format:'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best',   ext:'mp4', best:false },
        { type:'video', label:'480p',          format:'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best',   ext:'mp4', best:false },
        { type:'video', label:'360p',          format:'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best',   ext:'mp4', best:false },
      );
    }

  } else if (platform === 'facebook') {
    qs.push(
      { type:'video', label:'HD Quality', format:'best[height>=720]/bestvideo+bestaudio/best', ext:'mp4', best:true  },
      { type:'video', label:'SD Quality', format:'worst[ext=mp4]/worst',                       ext:'mp4', best:false }
    );

  } else if (platform === 'tiktok') {
    // yt-dlp downloads TikTok watermark-free by default via their API endpoint
    qs.push(
      { type:'video', label:'Original HD (No Watermark)', format:'play/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best', ext:'mp4', best:true, nowatermark:true },
      { type:'video', label:'Standard Quality', format:'h264_540p_492879-0/worst[ext=mp4]/worst', ext:'mp4', best:false }
    );

  } else if (platform === 'instagram') {
    qs.push(
      { type:'video', label:'Original Quality (HD)', format:'best[ext=mp4]/best', ext:'mp4', best:true },
      { type:'video', label:'Standard Quality',      format:'worst[ext=mp4]/worst', ext:'mp4', best:false }
    );

  } else if (platform === 'pinterest') {
    qs.push(
      { type:'video', label:'Original HD Video', format:'bestvideo+bestaudio/best', ext:'mp4', best:true }
    );

  } else if (platform === 'twitter') {
    qs.push(
      { type:'video', label:'Original Quality (HD)', format:'best[ext=mp4]/bestvideo+bestaudio/best', ext:'mp4', best:true },
      { type:'video', label:'Standard Quality',      format:'worst[ext=mp4]/worst',                   ext:'mp4', best:false }
    );

  } else if (platform === 'reddit') {
    // Reddit serves video and audio separately (DASH), merge them with ffmpeg
    qs.push(
      { type:'video', label:'Best Quality (with Sound)', format:'bestvideo+bestaudio/best',                          ext:'mp4', best:true  },
      { type:'video', label:'720p',                      format:'bestvideo[height<=720]+bestaudio/best[height<=720]/best', ext:'mp4', best:false },
      { type:'video', label:'480p',                      format:'bestvideo[height<=480]+bestaudio/best[height<=480]/best', ext:'mp4', best:false }
    );

  } else {
    qs.push(
      { type:'video', label:'Best Quality', format:'bestvideo+bestaudio/best', ext:'mp4', best:true }
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
   ROUTE: Health check + yt-dlp version
   ═══════════════════════════════════════════════════════════ */
app.get('/api/check', (req, res) => {
  try {
    const version = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 5000 }).trim();
    res.json({ ok: true, version });
  } catch {
    res.json({ ok: false, version: null });
  }
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
    '--extractor-args', 'youtube:skip=translated_subs,hls', // ⚡ Skip unnecessary data
  ];
  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }
  args.push(url);

  const ytdlp = spawn('yt-dlp', args);

  let stdout = '';
  let stderr = '';

  ytdlp.stdout.on('data', chunk => { stdout += chunk.toString(); });
  ytdlp.stderr.on('data', chunk => { stderr += chunk.toString(); });

  ytdlp.on('close', code => {
    if (code !== 0) {
      console.error(`[INFO] yt-dlp exited ${code}:`, stderr.slice(0, 300));
      let msg = 'Failed to fetch video info. Please check the URL and try again.';
      if (/Instagram API|empty media response/i.test(stderr)) msg = 'Instagram requires login cookies. Please add cookies.txt to project folder.';
      if (/Unsupported URL/i.test(stderr))  msg = 'Unsupported URL. Use a YouTube, Facebook, TikTok, Instagram, Pinterest, Twitter (X) or Reddit link.';
      if (/No video could be found|no video formats|does not contain any video/i.test(stderr)) msg = 'No video found in this post. Make sure the link points to a post that contains a video.';
      if (/Private video/i.test(stderr))    msg = 'This video is private and cannot be downloaded.';
      if (/not available/i.test(stderr))    msg = 'Video not available (removed or region-restricted).';
      if (/age.restrict/i.test(stderr))     msg = 'Age-restricted video: cannot download without login.';
      if (/Sign in/i.test(stderr))          msg = 'Login required. Only public videos are supported.';
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
    '-o', previewPath,
  ];
  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }
  args.push(url);

  const proc = spawn('yt-dlp', args);

  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(previewPath)) {
      console.log(`[PREVIEW] Ready: "${path.basename(previewPath)}" (${(fs.statSync(previewPath).size / 1024 / 1024).toFixed(2)} MB)`);
      return streamFile(previewPath);
    } else {
      console.error(`[PREVIEW] Failed with code ${code}`);
      if (!res.headersSent) res.status(500).send('Preview generation failed.');
    }
  });

  proc.on('error', (err) => {
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

  console.log(`[DOWNLOAD] Starting: "${filename}" | type=${type || 'video'}`);

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
    if (fs.existsSync(COOKIES_FILE)) dlArgs.push('--cookies', COOKIES_FILE);
    dlArgs.push(url);

    const proc = spawn('yt-dlp', dlArgs);
    req.on('close', () => {
      try { proc.kill(); } catch {}
    });

    proc.on('close', (code) => {
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
      console.error('[GIF] yt-dlp error:', err.message);
      if (!res.headersSent) res.status(500).send('yt-dlp spawn failed.');
    });

    return;
  }

  // Build yt-dlp arguments (optimized for speed)
  let args;
  if (type === 'audio') {
    args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', audioQuality || '0',
      '--no-playlist',
      '--playlist-items', '1',   // posts with several videos: first one only
      '--no-warnings',
      '--no-check-certificate',
      '--no-check-formats',
      '--concurrent-fragments', '4',   // ⚡ Download 4 fragments in parallel
      '--socket-timeout', '30',
      '-o', '-',
      url,
    ];
  } else {
    const fmtStr = (format || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best').replace(/\s+/g, '+');
    args = [
      '-f', fmtStr,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--playlist-items', '1',   // posts with several videos: first one only
      '--no-warnings',
      '--no-check-certificate',
      '--no-check-formats',
      '--concurrent-fragments', '4',   // ⚡ Download 4 fragments in parallel
      '--http-chunk-size', '10M',      // ⚡ Larger chunks = fewer requests
      '--socket-timeout', '30',
      '-o', '-',
      url,
    ];
  }

  if (fs.existsSync(COOKIES_FILE)) {
    args.splice(args.length - 1, 0, '--cookies', COOKIES_FILE);
  }

  // HTTP response headers
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', fileExt === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const ytdlp = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Stream yt-dlp output directly to browser
  ytdlp.stdout.pipe(res);

  // Show progress in server console
  ytdlp.stderr.on('data', chunk => {
    const line = chunk.toString().trim();
    if (line && line.includes('%')) process.stderr.write(`\r[yt-dlp] ${line}`);
  });

  ytdlp.on('close', code => {
    console.log(`\n[DOWNLOAD] Done (code ${code}) | "${filename}"`);
  });

  ytdlp.on('error', err => {
    console.error('[DOWNLOAD] Spawn error:', err.message);
    if (!res.headersSent) res.status(500).end('Download failed: yt-dlp not found.');
  });

  res.on('close', () => ytdlp.kill('SIGTERM'));
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
