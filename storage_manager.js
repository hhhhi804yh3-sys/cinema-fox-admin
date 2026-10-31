const https = require('https');
const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'hhhhi804yh3-sys';
const REPO_NAME = 'cinema-fox-admin';
const BRANCH = 'main';

// In-Memory Fast Caches
let cachedCatalog = null;
let cachedRequests = null;
let cachedAnalytics = {
  devices: {},
  totalSessions: 0,
  lastUpdated: Date.now()
};

// GitHub API Helper: Fetch file content and SHA
function getGithubFile(filePath) {
  return new Promise((resolve) => {
    if (!GITHUB_TOKEN) return resolve(null);
    const req = https.request(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}?ref=${BRANCH}`, {
      method: 'GET',
      headers: {
        'User-Agent': 'CinemaFox-Storage',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            const content = Buffer.from(parsed.content, 'base64').toString('utf8');
            resolve({ sha: parsed.sha, content: JSON.parse(content) });
          } catch(e) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// GitHub API Helper: Save or update file
function saveGithubFile(filePath, jsonContent, message) {
  return new Promise(async (resolve) => {
    if (!GITHUB_TOKEN) return resolve(false);
    try {
      const existing = await getGithubFile(filePath);
      const postData = JSON.stringify({
        message: message || `update: ${filePath}`,
        content: Buffer.from(JSON.stringify(jsonContent, null, 2)).toString('base64'),
        branch: BRANCH,
        sha: existing ? existing.sha : undefined
      });

      const req = https.request(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`, {
        method: 'PUT',
        headers: {
          'User-Agent': 'CinemaFox-Storage',
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 201);
      });
      req.on('error', () => resolve(false));
      req.write(postData);
      req.end();
    } catch(e) {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------
// CATALOG PERSISTENCE
// ---------------------------------------------------------------
async function loadCatalog() {
  if (cachedCatalog !== null) return cachedCatalog;

  // 1. Try reading from GitHub Repository
  const ghFile = await getGithubFile('data/published_catalog.json');
  if (ghFile && Array.isArray(ghFile.content) && ghFile.content.length > 0) {
    cachedCatalog = ghFile.content;
    return cachedCatalog;
  }

  // 2. Fallback to local extracted_subjects.json
  try {
    const localPath = path.join(__dirname, 'extracted_subjects.json');
    if (fs.existsSync(localPath)) {
      const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      cachedCatalog = localData.slice(0, 30).map((item, idx) => ({
        ...item,
        id: item.subjectId || `work_${idx + 1}`,
        titleAr: item.titleAr || item.title,
        hidden: false,
        featured: idx < 4,
        publishedAt: new Date(Date.now() - (idx * 3600000)).toISOString()
      }));
      // Asynchronously seed GitHub
      saveGithubFile('data/published_catalog.json', cachedCatalog, 'seed: initial catalog from local extracted subjects');
      return cachedCatalog;
    }
  } catch(e){}

  cachedCatalog = [];
  return cachedCatalog;
}

async function persistCatalog(newCatalog) {
  cachedCatalog = newCatalog;
  // Non-blocking save to GitHub
  saveGithubFile('data/published_catalog.json', newCatalog, `sync: catalog updated (${newCatalog.length} works)`).catch(() => {});
}

// ---------------------------------------------------------------
// VIEWER REQUESTS PERSISTENCE
// ---------------------------------------------------------------
async function loadRequests() {
  if (cachedRequests !== null) return cachedRequests;

  const ghFile = await getGithubFile('data/viewer_requests.json');
  if (ghFile && Array.isArray(ghFile.content)) {
    cachedRequests = ghFile.content;
    return cachedRequests;
  }

  // Initial Seed
  cachedRequests = [
    { id: "req_1", title: "Game of Thrones", type: "مسلسل", year: "2019", notes: "يرجى توفير جميع المواسم بدقة 1080p مع الترجمة العربية", date: "منذ 15 دقيقة", status: "pending" },
    { id: "req_2", title: "Inception", type: "فيلم", year: "2010", notes: "مترجم عربي عالي الجودة Full HD", date: "منذ ساعة", status: "pending" },
    { id: "req_3", title: "قيامة عثمان", type: "مسلسل", year: "2024", notes: "الحلقة 165 مترجمة حصرياً", date: "منذ ساعتين", status: "pending" }
  ];
  saveGithubFile('data/viewer_requests.json', cachedRequests, 'seed: initial viewer requests');
  return cachedRequests;
}

async function persistRequests(newRequests) {
  cachedRequests = newRequests;
  saveGithubFile('data/viewer_requests.json', newRequests, `sync: viewer requests updated (${newRequests.length} requests)`).catch(() => {});
}

// ---------------------------------------------------------------
// ANALYTICS & ACTIVE USERS PERSISTENCE
// ---------------------------------------------------------------
async function loadAnalytics() {
  const ghFile = await getGithubFile('data/analytics.json');
  if (ghFile && ghFile.content && typeof ghFile.content === 'object') {
    cachedAnalytics = {
      ...cachedAnalytics,
      ...ghFile.content,
      devices: { ...cachedAnalytics.devices, ...(ghFile.content.devices || {}) }
    };
  }
  return cachedAnalytics;
}

function recordDevicePing(deviceInfo) {
  const deviceId = deviceInfo.deviceId || 'unknown_device';
  const now = Date.now();

  cachedAnalytics.devices[deviceId] = {
    deviceId: deviceId,
    model: deviceInfo.model || 'Android Device',
    platform: deviceInfo.platform || 'Android',
    appVersion: deviceInfo.appVersion || '1.0.0',
    lastActive: now,
    firstSeen: cachedAnalytics.devices[deviceId]?.firstSeen || now,
    sessionCount: (cachedAnalytics.devices[deviceId]?.sessionCount || 0) + 1
  };

  cachedAnalytics.totalSessions++;
  cachedAnalytics.lastUpdated = now;

  // Persist periodically (throttled every 60 seconds)
  if (!recordDevicePing._lastSaved || (now - recordDevicePing._lastSaved) > 60000) {
    recordDevicePing._lastSaved = now;
    saveGithubFile('data/analytics.json', cachedAnalytics, 'sync: analytics ping update').catch(() => {});
  }
}

function getLiveAnalyticsSummary() {
  const now = Date.now();
  const fifteenMinsAgo = now - (15 * 60 * 1000);
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const deviceList = Object.values(cachedAnalytics.devices);
  const activeNow = deviceList.filter(d => d.lastActive > fifteenMinsAgo).length;
  const activeToday = deviceList.filter(d => d.lastActive > oneDayAgo).length;

  return {
    activeNow: Math.max(activeNow, 1), // At least current active session
    activeToday: Math.max(activeToday, 1),
    totalDevices: Math.max(deviceList.length, 1),
    totalSessions: cachedAnalytics.totalSessions,
    recentDevices: deviceList.sort((a, b) => b.lastActive - a.lastActive).slice(0, 10)
  };
}

module.exports = {
  loadCatalog,
  persistCatalog,
  loadRequests,
  persistRequests,
  loadAnalytics,
  recordDevicePing,
  getLiveAnalyticsSummary
};
