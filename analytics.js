'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[ANALYTICS] Failed to create data dir:', err.message);
  }
}

// Default schema
const DEFAULT_STATS = {
  totalVisitors: 0,
  totalDownloads: 0,
  platforms: {
    youtube: 0,
    facebook: 0,
    tiktok: 0,
    instagram: 0,
    twitter: 0,
    pinterest: 0,
    reddit: 0,
    other: 0,
  },
  recentDownloads: [],
  dailyStats: {},
};

let stats = { ...DEFAULT_STATS };

// Load stats from disk on startup
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      stats = {
        totalVisitors: parsed.totalVisitors || 0,
        totalDownloads: parsed.totalDownloads || 0,
        platforms: Object.assign({}, DEFAULT_STATS.platforms, parsed.platforms || {}),
        recentDownloads: Array.isArray(parsed.recentDownloads) ? parsed.recentDownloads : [],
        dailyStats: parsed.dailyStats || {},
      };
    } else {
      saveStatsImmediate();
    }
  } catch (err) {
    console.error('[ANALYTICS] Load error:', err.message);
    stats = { ...DEFAULT_STATS };
  }
}

// Debounced save to avoid disk trashing
let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveStatsImmediate, 1500);
}

function saveStatsImmediate() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf8');
  } catch (err) {
    console.error('[ANALYTICS] Save error:', err.message);
  }
}

function getTodayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function ensureTodayStats() {
  const key = getTodayKey();
  if (!stats.dailyStats[key]) {
    stats.dailyStats[key] = { visitors: 0, downloads: 0 };
  }
  return stats.dailyStats[key];
}

/** Record a new visitor session */
function recordVisit() {
  stats.totalVisitors = (stats.totalVisitors || 0) + 1;
  const today = ensureTodayStats();
  today.visitors = (today.visitors || 0) + 1;
  scheduleSave();
}

/** Record a successful video/audio/gif download */
function recordDownload({ platform, title, type, ext }) {
  stats.totalDownloads = (stats.totalDownloads || 0) + 1;

  const pKey = platform && stats.platforms.hasOwnProperty(platform) ? platform : 'other';
  stats.platforms[pKey] = (stats.platforms[pKey] || 0) + 1;

  const today = ensureTodayStats();
  today.downloads = (today.downloads || 0) + 1;

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    platform: pKey,
    title: (title || 'MediaZip Video').slice(0, 120),
    type: type || 'video',
    ext: ext || 'mp4',
    timestamp: new Date().toISOString(),
  };

  stats.recentDownloads.unshift(item);
  // Keep only the most recent 100 downloads
  if (stats.recentDownloads.length > 100) {
    stats.recentDownloads = stats.recentDownloads.slice(0, 100);
  }

  scheduleSave();
  return item;
}

/** Get summarized analytics payload for dashboard */
function getAnalytics() {
  const todayKey = getTodayKey();
  const today = stats.dailyStats[todayKey] || { visitors: 0, downloads: 0 };

  // Calculate top platform
  let topPlatform = 'None';
  let maxCount = 0;
  for (const [p, count] of Object.entries(stats.platforms)) {
    if (count > maxCount) {
      maxCount = count;
      topPlatform = p.charAt(0).toUpperCase() + p.slice(1);
    }
  }

  return {
    totalVisitors: stats.totalVisitors,
    totalDownloads: stats.totalDownloads,
    todayVisitors: today.visitors,
    todayDownloads: today.downloads,
    topPlatform: maxCount > 0 ? `${topPlatform} (${maxCount})` : 'No data yet',
    platforms: stats.platforms,
    recentDownloads: stats.recentDownloads,
    dailyStats: stats.dailyStats,
  };
}

/** Clear download log history while preserving counters */
function clearRecentLogs() {
  stats.recentDownloads = [];
  saveStatsImmediate();
}

// Initialize on module load
loadStats();

module.exports = {
  recordVisit,
  recordDownload,
  getAnalytics,
  clearRecentLogs,
};
