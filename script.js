/* ============================================================
   MediaZip - script.js  (Full Real API Integration)
   ============================================================ */
'use strict';

/* ── API Config ─────────────────────────────────────────── */
const API_BASE = (window.location.protocol === 'file:' || (window.location.port !== '3000' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')))
  ? 'http://localhost:3000'
  : '';

/* ── Helpers ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

let currentVideoUrl  = '';   // URL of last fetched video
let currentVideoInfo = null; // last /api/info response

/* ── Toast notification ──────────────────────────────────── */
function showToast(msg, type = 'success') {
  const toast = $('toast');
  const icon  = toast.querySelector('.toast-icon');
  $('toastMsg').textContent = msg;

  toast.classList.remove('error', 'warning', 'success');
  toast.classList.add(type);

  if (type === 'error') {
    icon.className = 'fas fa-times-circle toast-icon';
    icon.style.color = '#ef4444';
  } else if (type === 'warning') {
    icon.className = 'fas fa-exclamation-triangle toast-icon';
    icon.style.color = '#f59e0b';
  } else {
    icon.className = 'fas fa-check-circle toast-icon';
    icon.style.color = ''; // Handled by CSS for both dark and light modes
  }
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

/* ── Navbar & Scroll ─────────────────────────────────────── */
const navbar = $('navbar');

window.addEventListener('scroll', () => {
  if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 20);
  const st = $('scrollTop');
  if (st) st.classList.toggle('visible', window.scrollY > 400);
}, { passive: true });

/* ── Scroll to Top ───────────────────────────────────────── */
const scrollTopBtn = $('scrollTop');
if (scrollTopBtn) scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* ── Platform Detection ──────────────────────────────────── */
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url))      return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url))     return 'facebook';
  if (/tiktok\.com/i.test(url))                 return 'tiktok';
  if (/instagram\.com|instagr\.am/i.test(url))  return 'instagram';
  if (/pinterest\.com|pin\.it/i.test(url))      return 'pinterest';
  if (/(?:^|\/\/|\.)(?:twitter|x)\.com|\/\/t\.co\//i.test(url)) return 'twitter';
  if (/reddit\.com|redd\.it/i.test(url))        return 'reddit';
  return null;
}
function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

/* ── Platform Badge Highlight on Input ───────────────────── */
$('videoUrl').addEventListener('input', () => {
  const p = detectPlatform($('videoUrl').value);
  $$('.platform-badge').forEach(b => b.style.transform = '');
  if (p) {
    const badge = document.querySelector(`.platform-badge.${p}`);
    if (badge) badge.style.transform = 'scale(1.12)';
  }
});

/* ═══════════════════════════════════════════════════════════
   CLIPBOARD HELPERS (shared by Paste button + Smart Auto-Paste)
   ═══════════════════════════════════════════════════════════ */
const PLATFORM_LABELS = {
  youtube: 'YouTube', facebook: 'Facebook', tiktok: 'TikTok',
  instagram: 'Instagram', pinterest: 'Pinterest', twitter: 'Twitter / X', reddit: 'Reddit',
};

/** Pull the first supported video URL out of any text (apps often share "caption + link"). */
function extractVideoUrl(text) {
  if (!text) return null;
  const matches = String(text).match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches) return null;
  for (const raw of matches) {
    const clean = raw.replace(/[)\].,;!?]+$/, '');
    if (detectPlatform(clean)) return clean;
  }
  return null;
}

function applyUrlToInput(url, highlight = false) {
  const input = $('videoUrl');
  input.value = url;
  input.dispatchEvent(new Event('input'));
  if (highlight) {
    input.classList.remove('auto-pasted');
    void input.offsetWidth; // restart the glow animation
    input.classList.add('auto-pasted');
  }
}

/* ── Paste Button ────────────────────────────────────────── */
$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const url  = extractVideoUrl(text);
    if (url) {
      lastClipboardHandled = url;
      applyUrlToInput(url);
      showToast('Link pasted!');
    } else if (text && text.trim().startsWith('http')) {
      applyUrlToInput(text.trim());
      showToast('Link pasted!');
    } else {
      showToast('No valid URL in clipboard', 'warning');
    }
  } catch {
    $('videoUrl').focus();
    showToast('Press Ctrl+V to paste manually', 'warning');
  }
});

/* ═══════════════════════════════════════════════════════════
   SMART AUTO-PASTE
   Detects a copied video link when the user opens / returns to
   the page and drops it into the input box automatically.
   ═══════════════════════════════════════════════════════════ */
const AUTO_PASTE_KEY   = 'mediazip_autopaste';
const HINT_DEFAULT     = 'Copy a video link, then return here to paste it automatically.';
const HINT_OFF         = 'Auto-paste is off. Use the Paste button or Ctrl+V.';
const autoPasteToggle  = $('autoPasteToggle');
const autoPasteHint    = $('autoPasteHint');

let lastClipboardHandled = '';   // never auto-paste the same copied link twice
let autoPasteBusy        = false;
let autoPasteNeedsTap    = false; // browser wanted a user gesture first (Firefox/Safari)
let hintTimer            = null;

function setAutoPasteHint(msg, cls = '') {
  if (!autoPasteHint) return;
  autoPasteHint.textContent = msg;
  autoPasteHint.className   = 'auto-paste-hint' + (cls ? ' ' + cls : '');
  clearTimeout(hintTimer);
  if (cls === 'success') {
    hintTimer = setTimeout(() => {
      if (autoPasteHint.textContent === msg) {
        setAutoPasteHint(autoPasteToggle.checked ? HINT_DEFAULT : HINT_OFF);
      }
    }, 6000);
  }
}

async function tryAutoPaste() {
  if (!autoPasteToggle || !autoPasteToggle.checked || autoPasteBusy) return;
  if (!navigator.clipboard || !navigator.clipboard.readText) return;
  if (!document.hasFocus()) return;                    // browsers only allow clipboard reads on a focused page

  const input   = $('videoUrl');
  const current = input.value.trim();
  if (document.activeElement === input && current) return; // user is editing: don't interfere

  autoPasteBusy = true;
  try {
    const text = await navigator.clipboard.readText();
    autoPasteNeedsTap = false;

    const url = extractVideoUrl(text);
    if (!url || url === lastClipboardHandled) return;

    // Only replace an empty box or an existing supported link (never user-typed text)
    if (current && !detectPlatform(current)) return;
    if (current === url) { lastClipboardHandled = url; return; }

    lastClipboardHandled = url;
    applyUrlToInput(url, true);
    const label = PLATFORM_LABELS[detectPlatform(url)] || 'Video';
    showToast(`⚡ ${label} link detected & pasted!`);
    setAutoPasteHint(`${label} link pasted from clipboard. Click Download to start.`, 'success');
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      autoPasteNeedsTap = true;
      setAutoPasteHint('Tap anywhere (or allow clipboard access) so the copied link can be pasted.', 'warning');
    }
  } finally {
    autoPasteBusy = false;
  }
}

/* Toggle (remembered across visits) */
if (autoPasteToggle) {
  autoPasteToggle.checked = localStorage.getItem(AUTO_PASTE_KEY) !== 'off';
  setAutoPasteHint(autoPasteToggle.checked ? HINT_DEFAULT : HINT_OFF);

  autoPasteToggle.addEventListener('change', () => {
    localStorage.setItem(AUTO_PASTE_KEY, autoPasteToggle.checked ? 'on' : 'off');
    setAutoPasteHint(autoPasteToggle.checked ? HINT_DEFAULT : HINT_OFF);
    showToast(autoPasteToggle.checked ? '⚡ Smart Auto-Paste enabled' : 'Smart Auto-Paste disabled', autoPasteToggle.checked ? 'success' : 'warning');
    if (autoPasteToggle.checked) { lastClipboardHandled = ''; tryAutoPaste(); }
  });
}

/* Triggers: page open, tab/window regains focus, tab becomes visible */
window.addEventListener('load', () => setTimeout(tryAutoPaste, 500));
window.addEventListener('focus', () => setTimeout(tryAutoPaste, 150));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(tryAutoPaste, 150);
});

/* Gesture fallback: browsers that refuse silent clipboard reads allow it after a tap/click */
document.addEventListener('pointerdown', () => {
  if (autoPasteNeedsTap) { autoPasteNeedsTap = false; tryAutoPaste(); }
}, { passive: true });
$('videoUrl').addEventListener('focus', () => {
  if (autoPasteNeedsTap) { autoPasteNeedsTap = false; tryAutoPaste(); }
});

/* Ctrl+V anywhere on the page (outside a text field) fills the box: works in every browser */
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const url = extractVideoUrl(e.clipboardData && e.clipboardData.getData('text'));
  if (!url) return;
  e.preventDefault();
  lastClipboardHandled = url;
  applyUrlToInput(url, true);
  showToast(`⚡ ${PLATFORM_LABELS[detectPlatform(url)] || 'Video'} link pasted!`);
});

/* Pasting "caption text + link" straight into the box keeps only the clean link */
$('videoUrl').addEventListener('paste', (e) => {
  const text = e.clipboardData && e.clipboardData.getData('text');
  const url  = extractVideoUrl(text);
  if (url && url !== text.trim()) {
    e.preventDefault();
    lastClipboardHandled = url;
    applyUrlToInput(url);
  }
});

/* ═══════════════════════════════════════════════════════════
   LOADING BAR
   ═══════════════════════════════════════════════════════════ */
function setLoadingState(pct, text) {
  const bar  = $('loadingBar');
  const fill = $('loadingFill');
  const txt  = $('loadingText');
  if (pct === null) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width  = pct + '%';
  txt.textContent   = text || '';
}

/* ═══════════════════════════════════════════════════════════
   REAL API: Fetch Video Info
   ═══════════════════════════════════════════════════════════ */
async function fetchVideoInfo(url) {
  const res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch video info');
  return data;
}

/* ═══════════════════════════════════════════════════════════
   REAL DOWNLOAD: opens native browser download
   ═══════════════════════════════════════════════════════════ */
function triggerDownload(quality) {
  if (!currentVideoUrl) { showToast('No video URL loaded', 'error'); return; }

  const params = new URLSearchParams({
    url:          currentVideoUrl,
    label:        currentVideoInfo?.title || 'MediaZip',
    type:         quality.type,
    ext:          quality.ext   || 'mp4',
    format:       quality.format       || '',
    audioQuality: quality.audioQuality || '0',
    gifWidth:     quality.gifWidth     || '480',
    gifFps:       quality.gifFps       || '12',
    gifDuration:  quality.gifDuration  || '10',
  });

  const downloadUrl = `${API_BASE}/api/download?${params}`;

  // Use hidden anchor for clean download trigger
  const anchor = document.createElement('a');
  anchor.href     = downloadUrl;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  if (quality.type === 'gif') {
    showToast(`🎨 Generating animated GIF (${quality.label})… please wait a moment!`);
  } else {
    showToast(`⬇ Downloading "${quality.label}"…`);
  }
}

/* ═══════════════════════════════════════════════════════════
   BUILD QUALITY / AUDIO BUTTONS
   ═══════════════════════════════════════════════════════════ */
function buildDownloadOptions(qualities) {
  const qGrid = $('qualityGrid');
  const aGrid = $('audioGrid');
  qGrid.innerHTML = '';
  aGrid.innerHTML = '';

  const videoQ  = qualities.filter(q => q.type === 'video');
  const audioQ  = qualities.filter(q => q.type === 'audio');

  videoQ.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (q.best ? ' best' : '') + (q.nowatermark ? ' nowatermark' : '');

    let iconHtml = '<i class="fas fa-video"></i>';
    if (q.nowatermark) iconHtml = '<i class="fas fa-magic"></i>';

    btn.innerHTML = `
      <span class="res-label">${iconHtml} ${q.label}</span>
      ${q.nowatermark ? '<span class="size-label" style="color:var(--accent-cyan);">TikTok Exclusive</span>' : ''}
    `;
    btn.title = q.label;
    btn.addEventListener('click', () => triggerDownload(q));
    qGrid.appendChild(btn);
  });

  audioQ.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'audio-btn';
    btn.innerHTML = `
      <i class="fas fa-music"></i>
      <span>${q.label}</span>
      <span class="quality-sub">${q.ext.toUpperCase()}</span>
    `;
    btn.addEventListener('click', () => triggerDownload(q));
    aGrid.appendChild(btn);
  });
}

/* ═══════════════════════════════════════════════════════════
   SHOW PREVIEW CARD (with real API data)
   ═══════════════════════════════════════════════════════════ */
function showPreview(info) {
  currentVideoInfo = info;

  // Platform tag
  const tag    = $('platformTag');
  const tagMap = {
    youtube:   ['yt',  '<i class="fab fa-youtube"></i> YouTube'],
    facebook:  ['fb',  '<i class="fab fa-facebook"></i> Facebook'],
    tiktok:    ['tt',  '<i class="fab fa-tiktok"></i> TikTok'],
    instagram: ['ig',  '<i class="fab fa-instagram"></i> Instagram'],
    pinterest: ['pin', '<i class="fab fa-pinterest"></i> Pinterest'],
    twitter:   ['tw',  '<i class="fab fa-x-twitter"></i> Twitter / X'],
    reddit:    ['rd',  '<i class="fab fa-reddit-alien"></i> Reddit'],
  };
  const [cls, html2] = tagMap[info.platform] || ['yt', '<i class="fas fa-play"></i> Video'];
  tag.className   = `platform-tag ${cls}`;
  tag.innerHTML   = html2;

  // Thumbnail
  const thumb = $('previewThumb');
  if (info.thumbnail) {
    thumb.src = info.thumbnail;
    thumb.onerror = () => { thumb.src = 'https://via.placeholder.com/640x360/0a0b14/00d9ff?text=MediaZip'; };
  }

  // Meta
  $('previewTitle').textContent   = info.title    || 'Untitled';
  $('previewChannel').textContent = info.uploader || 'Unknown';
  $('previewViews').textContent   = info.views    || '';
  $('previewDuration').textContent = info.duration || '';

  // Quality & Audio buttons
  buildDownloadOptions(info.qualities || []);

  // TikTok No-Watermark special section
  $('tiktokSpecial').style.display = info.platform === 'tiktok' ? 'block' : 'none';

  // Show the card
  const sec = $('previewSection');
  sec.style.display = 'block';

  // Small delay so section is rendered before scroll
  setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

/* ═══════════════════════════════════════════════════════════
   MAIN DOWNLOAD HANDLER
   ═══════════════════════════════════════════════════════════ */
async function handleDownload() {
  const url = $('videoUrl').value.trim();

  if (!url) {
    showToast('Please paste a video URL first!', 'error');
    $('inputContainer').classList.add('shake');
    setTimeout(() => $('inputContainer').classList.remove('shake'), 500);
    return;
  }
  if (!isValidUrl(url)) {
    showToast('Please enter a valid URL!', 'error');
    return;
  }
  const platform = detectPlatform(url);
  if (!platform) {
    showToast('Supported: YouTube, Facebook, TikTok, Instagram, Pinterest, Twitter (X) & Reddit', 'error');
    return;
  }

  // Reset
  $('previewSection').style.display = 'none';
  currentVideoUrl  = url;
  currentVideoInfo = null;

  // Show loading immediately: no artificial delays
  setLoadingState(10, 'Fetching video info…');

  try {
    const info = await fetchVideoInfo(url);   // Real API call
    setLoadingState(95, 'Almost done…');

    // One tiny RAF to let the progress bar render
    await new Promise(r => requestAnimationFrame(r));
    setLoadingState(null);
    showPreview(info);

  } catch(err) {
    setLoadingState(null);
    showToast(err.message || 'Could not fetch video. Is the server running?', 'error');
    console.error('[MediaZip]', err);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


/* ── Bind download triggers ──────────────────────────────── */
$('downloadBtn').addEventListener('click', handleDownload);
$('videoUrl').addEventListener('keydown', e => { if (e.key === 'Enter') handleDownload(); });

/* ═══════════════════════════════════════════════════════════
   WATCH PREVIEW VIDEO PLAYER MODAL
   ═══════════════════════════════════════════════════════════ */
function openVideoPlayer() {
  if (!currentVideoInfo || !currentVideoUrl) {
    showToast('Please fetch a video first!', 'warning');
    return;
  }

  const modal = $('playerModal');
  const container = $('videoContainer');
  const titleEl = $('playerModalTitle');
  const badgeEl = $('playerPlatformBadge');
  const durEl = $('playerDurationText');

  if (!modal || !container) return;

  if (titleEl) titleEl.textContent = currentVideoInfo.title || 'Watch Video Preview';
  if (durEl) durEl.textContent = currentVideoInfo.duration ? `Duration: ${currentVideoInfo.duration}` : '';
  if (badgeEl) {
    const p = currentVideoInfo.platform || 'video';
    badgeEl.textContent = p.toUpperCase();
    badgeEl.className = `player-video-badge ${p}`;
  }

  // Clear previous player
  container.innerHTML = '';

  // 1. YouTube: embed iframe (instant, perfect, zero buffering)
  if (currentVideoInfo.platform === 'youtube' && (currentVideoInfo.embedUrl || currentVideoInfo.id)) {
    const embedUrl = currentVideoInfo.embedUrl || `https://www.youtube-nocookie.com/embed/${currentVideoInfo.id}?autoplay=1`;
    container.innerHTML = `
      <iframe 
        src="${embedUrl}" 
        title="Video Preview" 
        frameborder="0" 
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
        allowfullscreen>
      </iframe>
    `;
    modal.style.display = 'flex';
    return;
  }

  // 2. All other platforms (Pinterest, TikTok, Instagram, Facebook):
  // Show smooth loading spinner while local preview prepares
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'player-loading-spinner';
  loadingDiv.innerHTML = `
    <i class="fas fa-circle-notch fa-spin"></i>
    <span>Loading preview video...</span>
  `;
  container.appendChild(loadingDiv);
  modal.style.display = 'flex';

  const video = document.createElement('video');
  video.id = 'previewVideoEl';
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.style.display = 'none'; // hide until ready
  if (currentVideoInfo.thumbnail) video.poster = currentVideoInfo.thumbnail;

  const localPreviewUrl = `${API_BASE}/api/preview-video?url=${encodeURIComponent(currentVideoUrl)}`;
  video.src = localPreviewUrl;

  video.oncanplay = () => {
    loadingDiv.style.display = 'none';
    video.style.display = 'block';
    video.play().catch(() => {});
  };

  video.onerror = () => {
    loadingDiv.style.display = 'none';
    container.innerHTML = `
      <div class="player-fallback">
        <i class="fas fa-exclamation-circle"></i>
        <p>Could not load preview stream directly.</p>
        <a href="${currentVideoUrl}" target="_blank" rel="noopener noreferrer" class="player-fallback-btn">
          <i class="fas fa-external-link-alt"></i> Open on ${currentVideoInfo.platform ? currentVideoInfo.platform.toUpperCase() : 'Original Site'}
        </a>
      </div>
    `;
  };

  container.appendChild(video);
}

function closeVideoPlayer() {
  const modal = $('playerModal');
  const container = $('videoContainer');
  if (modal) modal.style.display = 'none';
  if (container) {
    const video = container.querySelector('video');
    if (video) {
      video.pause();
      video.src = '';
      video.load();
    }
    container.innerHTML = ''; // Stops playback and network requests immediately
  }
}

const openPlayerBtn = $('openPlayerBtn');
if (openPlayerBtn) openPlayerBtn.addEventListener('click', openVideoPlayer);

const previewThumbWrap = $('previewThumbWrap');
if (previewThumbWrap) previewThumbWrap.addEventListener('click', openVideoPlayer);

const closePlayerModalBtn = $('closePlayerModal');
if (closePlayerModalBtn) closePlayerModalBtn.addEventListener('click', closeVideoPlayer);

const playerModalEl = $('playerModal');
if (playerModalEl) {
  playerModalEl.addEventListener('click', (e) => {
    if (e.target === playerModalEl) closeVideoPlayer();
  });
}

const playerQuickDownloadBtn = $('playerQuickDownloadBtn');
if (playerQuickDownloadBtn) {
  playerQuickDownloadBtn.addEventListener('click', () => {
    closeVideoPlayer();
    const qGrid = $('qualityGrid');
    if (qGrid) {
      const bestBtn = qGrid.querySelector('.quality-btn.best') || qGrid.querySelector('.quality-btn');
      if (bestBtn) bestBtn.click();
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   MOBILE QR CODE MODAL
   ═══════════════════════════════════════════════════════════ */
function openMobileQr() {
  if (!currentVideoUrl) {
    showToast('Please fetch a video first!', 'warning');
    return;
  }
  const modal = $('qrModal');
  const qrImg = $('qrCodeImg');
  if (!modal || !qrImg) return;

  // Generate high-resolution QR Code using reliable API
  qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&margin=12&data=${encodeURIComponent(currentVideoUrl)}`;
  modal.style.display = 'flex';
}

function closeMobileQr() {
  const modal = $('qrModal');
  if (modal) modal.style.display = 'none';
}

const openQrBtn = $('openQrBtn');
if (openQrBtn) openQrBtn.addEventListener('click', openMobileQr);

const closeQrModalBtn = $('closeQrModal');
if (closeQrModalBtn) closeQrModalBtn.addEventListener('click', closeMobileQr);

const qrModalEl = $('qrModal');
if (qrModalEl) {
  qrModalEl.addEventListener('click', (e) => {
    if (e.target === qrModalEl) closeMobileQr();
  });
}

/* ═══════════════════════════════════════════════════════════
   GIF GENERATOR MODAL
   ═══════════════════════════════════════════════════════════ */
function openGifModal() {
  if (!currentVideoUrl) {
    showToast('Please fetch a video first!', 'warning');
    return;
  }
  const modal = $('gifModal');
  if (modal) modal.style.display = 'flex';
}

function closeGifModal() {
  const modal = $('gifModal');
  if (modal) modal.style.display = 'none';
}

function handleGifAction(e) {
  if (e) e.preventDefault();
  if (currentVideoUrl) {
    openGifModal();
  } else {
    const input = $('videoUrl');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    showToast('💡 Paste any video link above to convert it to an animated GIF!');
  }
}

const heroGifBadge = $('heroGifBadge');
if (heroGifBadge) heroGifBadge.addEventListener('click', handleGifAction);

const footerGifLink = $('footerGifLink');
if (footerGifLink) footerGifLink.addEventListener('click', handleGifAction);

const openGifModalBtn = $('openGifModalBtn');
if (openGifModalBtn) openGifModalBtn.addEventListener('click', openGifModal);

const closeGifModalBtn = $('closeGifModal');
if (closeGifModalBtn) closeGifModalBtn.addEventListener('click', closeGifModal);

const gifModalEl = $('gifModal');
if (gifModalEl) {
  gifModalEl.addEventListener('click', (e) => {
    if (e.target === gifModalEl) closeGifModal();
  });
}

// Download HQ GIF (10s)
const btnDownloadGifHq = $('btnDownloadGifHq');
if (btnDownloadGifHq) {
  btnDownloadGifHq.addEventListener('click', () => {
    closeGifModal();
    triggerDownload({
      type: 'gif',
      label: 'High Quality GIF (10s)',
      ext: 'gif',
      gifWidth: 480,
      gifFps: 14,
      gifDuration: 10,
    });
  });
}

// Download Compact GIF (5s)
const btnDownloadGifCompact = $('btnDownloadGifCompact');
if (btnDownloadGifCompact) {
  btnDownloadGifCompact.addEventListener('click', () => {
    closeGifModal();
    triggerDownload({
      type: 'gif',
      label: 'Compact GIF (5s)',
      ext: 'gif',
      gifWidth: 320,
      gifFps: 10,
      gifDuration: 5,
    });
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMobileQr();
    closeVideoPlayer();
    closeGifModal();
  }
});

/* ── TikTok No-Watermark button (inline HTML onclick) ────── */
window.simulateDownload = function(label) {
  // Legacy shim: find matching quality and trigger
  if (!currentVideoInfo) { showToast('Fetch a video first!', 'warning'); return; }
  const q = (currentVideoInfo.qualities || []).find(q => q.nowatermark);
  if (q) triggerDownload(q);
  else showToast('No-watermark option not available.', 'warning');
};

/* ═══════════════════════════════════════════════════════════
   FAQ ACCORDION
   ═══════════════════════════════════════════════════════════ */
function toggleFaq(el) {
  const isOpen = el.classList.contains('open');
  $$('.faq-item.open').forEach(i => i.classList.remove('open'));
  if (!isOpen) el.classList.add('open');
}
window.toggleFaq = toggleFaq;

/* ═══════════════════════════════════════════════════════════
   ANIMATED COUNTERS
   ═══════════════════════════════════════════════════════════ */
function animateCounters() {
  $$('.stat-number').forEach(el => {
    const target = parseInt(el.dataset.count);
    let current  = 0;
    const step   = Math.max(1, Math.ceil(target / 60));
    const id     = setInterval(() => {
      current = Math.min(current + step, target);
      el.textContent = current;
      if (current >= target) clearInterval(id);
    }, 22);
  });
}

/* ═══════════════════════════════════════════════════════════
   INTERSECTION OBSERVER (scroll animations + counter trigger)
   ═══════════════════════════════════════════════════════════ */
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('visible');
    if (entry.target.classList.contains('stats-section')) animateCounters();
    observer.unobserve(entry.target);
  });
}, { threshold: 0.12 });

$$('.feature-card, .step-card, .faq-item, .platform-text, .platform-visual')
  .forEach(el => { el.classList.add('fade-in'); observer.observe(el); });

const statsSec = document.querySelector('.stats-section');
if (statsSec) observer.observe(statsSec);

/* ═══════════════════════════════════════════════════════════
   SHAKE ANIMATION (keyframe injected once)
   ═══════════════════════════════════════════════════════════ */
const _style = document.createElement('style');
_style.textContent = `
  @keyframes shake {
    0%,100%{transform:translateX(0)}
    20%{transform:translateX(-8px)}
    40%{transform:translateX(8px)}
    60%{transform:translateX(-5px)}
    80%{transform:translateX(5px)}
  }
  .shake { animation: shake 0.4s ease !important; }

  /* Nowatermark quality button accent */
  .quality-btn.nowatermark {
    border-color: rgba(254,44,85,0.35) !important;
    background: rgba(254,44,85,0.06) !important;
  }
  .quality-btn.nowatermark:hover {
    border-color: rgba(254,44,85,0.7) !important;
    color: #fe2c55 !important;
  }
`;
document.head.appendChild(_style);

/* ═══════════════════════════════════════════════════════════
   SERVER STATUS CHECK on load
   ═══════════════════════════════════════════════════════════ */
async function checkServer() {
  try {
    const res  = await fetch(`${API_BASE}/api/check`, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (!data.ok) {
      showToast('⚠ yt-dlp not installed! Run install.bat to enable downloads.', 'warning');
    } else {
      console.log(`[MediaZip] yt-dlp v${data.version} ready ✔`);
    }
  } catch {
    // Server not running: opened index.html directly
    console.warn('[MediaZip] Backend server not detected. Start server with: node server.js');
    injectOfflineBanner();
  }
}

function injectOfflineBanner() {
  const banner = document.createElement('div');
  banner.id = 'offlineBanner';
  banner.innerHTML = `
    <i class="fas fa-server"></i>
    <span><strong>Server not running.</strong> Open a terminal and run <code>start.bat</code> to enable real downloads.</span>
    <button onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
  `;
  banner.style.cssText = `
    position:fixed; top:var(--navbar-h,72px); left:0; right:0;
    background: linear-gradient(90deg,rgba(247,37,133,0.12),rgba(155,93,229,0.12));
    border-bottom:1px solid rgba(247,37,133,0.25);
    display:flex; align-items:center; gap:12px;
    padding:10px 24px; font-size:0.85rem; color:var(--text-secondary);
    z-index:998; backdrop-filter:blur(10px);
  `;
  banner.querySelector('code').style.cssText = 'background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;font-family:monospace;color:var(--accent-cyan);';
  banner.querySelector('button').style.cssText = 'margin-left:auto;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:1rem;';
  document.body.appendChild(banner);
}

window.addEventListener('load', checkServer);
