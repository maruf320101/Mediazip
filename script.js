/* ============================================================
   MediaZip – script.js  (Full Real API Integration)
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

/* ── Theme Toggle ────────────────────────────────────────── */
const themeToggle = $('themeToggle');
const themeIcon   = $('themeIcon');
const html        = document.documentElement;

function applyTheme(theme) {
  html.setAttribute('data-theme', theme);
  themeIcon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
  localStorage.setItem('mz-theme', theme);
}
applyTheme(localStorage.getItem('mz-theme') || 'dark');
themeToggle.addEventListener('click', () => {
  applyTheme(html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

/* ── Navbar ──────────────────────────────────────────────── */
const navbar    = $('navbar');
const hamburger = $('hamburger');
const navLinks  = $('navLinks');

window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 20);
  $('scrollTop').classList.toggle('visible', window.scrollY > 400);
}, { passive: true });

hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  navLinks.classList.toggle('open');
});
$$('.nav-link').forEach(link =>
  link.addEventListener('click', () => {
    hamburger.classList.remove('open');
    navLinks.classList.remove('open');
  })
);

// Active section highlight
const sections = $$('section[id]');
window.addEventListener('scroll', () => {
  const scrollPos = window.scrollY + 80;
  sections.forEach(sec => {
    const link = document.querySelector(`.nav-link[href="#${sec.id}"]`);
    if (link) link.classList.toggle('active', scrollPos >= sec.offsetTop && scrollPos < sec.offsetTop + sec.offsetHeight);
  });
}, { passive: true });

/* ── Scroll to Top ───────────────────────────────────────── */
$('scrollTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* ── Platform Detection ──────────────────────────────────── */
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url))  return 'youtube';
  if (/facebook\.com|fb\.watch/i.test(url)) return 'facebook';
  if (/tiktok\.com/i.test(url))             return 'tiktok';
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

/* ── Paste Button ────────────────────────────────────────── */
$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.startsWith('http')) {
      $('videoUrl').value = text;
      $('videoUrl').dispatchEvent(new Event('input'));
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
   REAL DOWNLOAD — opens native browser download
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
  });

  const downloadUrl = `${API_BASE}/api/download?${params}`;

  // Use hidden anchor for clean download trigger
  const anchor = document.createElement('a');
  anchor.href     = downloadUrl;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  showToast(`⬇ Downloading "${quality.label}"…`);
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
    youtube:  ['yt', '<i class="fab fa-youtube"></i> YouTube'],
    facebook: ['fb', '<i class="fab fa-facebook"></i> Facebook'],
    tiktok:   ['tt', '<i class="fab fa-tiktok"></i> TikTok'],
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
    showToast('Only YouTube, Facebook & TikTok links are supported!', 'error');
    return;
  }

  // Reset
  $('previewSection').style.display = 'none';
  currentVideoUrl  = url;
  currentVideoInfo = null;

  // Show loading immediately — no artificial delays
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

/* ── TikTok No-Watermark button (inline HTML onclick) ────── */
window.simulateDownload = function(label) {
  // Legacy shim — find matching quality and trigger
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
    // Server not running — they opened index.html directly
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
