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
let cachedIncomingScrapes = null;
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

// -------------------------------------------------------------
// CATALOG DATA MANAGEMENT
// -------------------------------------------------------------
async function loadCatalog() {
  if (cachedCatalog !== null) return cachedCatalog;

  // 1. Try GitHub cloud storage
  const remote = await getGithubFile('data/published_catalog.json');
  if (remote && Array.isArray(remote.content)) {
    cachedCatalog = remote.content;
    return cachedCatalog;
  }

  // 2. Fallback to local file
  const localPath = path.join(__dirname, 'data', 'published_catalog.json');
  if (fs.existsSync(localPath)) {
    try {
      cachedCatalog = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return cachedCatalog;
    } catch(e) {}
  }

  // 3. Fallback to cinemana catalog if available
  const cinemanaPath = path.join(__dirname, 'cinemana_catalog.json');
  if (fs.existsSync(cinemanaPath)) {
    try {
      cachedCatalog = JSON.parse(fs.readFileSync(cinemanaPath, 'utf8'));
      return cachedCatalog;
    } catch(e) {}
  }

  cachedCatalog = [];
  return cachedCatalog;
}

async function persistCatalog(catalog) {
  cachedCatalog = catalog;

  // 1. Write local disk cache
  try {
    const localDir = path.join(__dirname, 'data');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'published_catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  } catch(e) {}

  // 2. Persist to GitHub repository
  await saveGithubFile('data/published_catalog.json', catalog, `sync: update catalog (${catalog.length} items)`);
  return true;
}

// -------------------------------------------------------------
// INCOMING MOVIEBOX DESKTOP SCRAPES MANAGEMENT
// -------------------------------------------------------------
async function loadIncomingScrapes() {
  if (cachedIncomingScrapes !== null) return cachedIncomingScrapes;

  // 1. Try GitHub cloud storage
  const remote = await getGithubFile('data/incoming_scrapes.json');
  if (remote && Array.isArray(remote.content)) {
    cachedIncomingScrapes = remote.content;
    return cachedIncomingScrapes;
  }

  // 2. Fallback to local file
  const localPath = path.join(__dirname, 'data', 'incoming_scrapes.json');
  if (fs.existsSync(localPath)) {
    try {
      cachedIncomingScrapes = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return cachedIncomingScrapes;
    } catch(e) {}
  }

  cachedIncomingScrapes = [];
  return cachedIncomingScrapes;
}

async function persistIncomingScrapes(scrapes) {
  cachedIncomingScrapes = scrapes;

  try {
    const localDir = path.join(__dirname, 'data');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'incoming_scrapes.json'), JSON.stringify(scrapes, null, 2), 'utf8');
  } catch(e) {}

  await saveGithubFile('data/incoming_scrapes.json', scrapes, `sync: update incoming desktop scrapes (${scrapes.length} items)`);
  return true;
}

// -------------------------------------------------------------
// VIEWER REQUESTS MANAGEMENT
// -------------------------------------------------------------
async function loadRequests() {
  if (cachedRequests !== null) return cachedRequests;

  const remote = await getGithubFile('data/viewer_requests.json');
  if (remote && Array.isArray(remote.content)) {
    cachedRequests = remote.content;
    return cachedRequests;
  }

  const localPath = path.join(__dirname, 'data', 'viewer_requests.json');
  if (fs.existsSync(localPath)) {
    try {
      cachedRequests = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      return cachedRequests;
    } catch(e) {}
  }

  cachedRequests = [];
  return cachedRequests;
}

async function persistRequests(requests) {
  cachedRequests = requests;

  try {
    const localDir = path.join(__dirname, 'data');
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'viewer_requests.json'), JSON.stringify(requests, null, 2), 'utf8');
  } catch(e) {}

  await saveGithubFile('data/viewer_requests.json', requests, `sync: update requests (${requests.length} items)`);
  return true;
}

// -------------------------------------------------------------
// LIVE ANALYTICS & ACTIVE USERS MANAGEMENT
// -------------------------------------------------------------
async function loadAnalytics() {
  const remote = await getGithubFile('data/analytics.json');
  if (remote && remote.content && remote.content.devices) {
    cachedAnalytics = remote.content;
  } else {
    const localPath = path.join(__dirname, 'data', 'analytics.json');
    if (fs.existsSync(localPath)) {
      try {
        cachedAnalytics = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      } catch(e) {}
    }
  }
  return cachedAnalytics;
}

function recordDevicePing(info) {
  const now = Date.now();
  const id = info.deviceId || 'unknown_device';

  if (!cachedAnalytics.devices[id]) {
    cachedAnalytics.totalSessions = (cachedAnalytics.totalSessions || 0) + 1;
  }

  cachedAnalytics.devices[id] = {
    id,
    deviceModel: info.deviceModel || 'Mobile Device',
    appVersion: info.appVersion || '3.0.0',
    ip: info.ip || '127.0.0.1',
    lastActive: now,
    firstSeen: cachedAnalytics.devices[id]?.firstSeen || now,
    pingCount: (cachedAnalytics.devices[id]?.pingCount || 0) + 1
  };
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

  const deviceList = Object.values(cachedAnalytics.devices || {});
  const activeNow = deviceList.filter(d => d.lastActive > fifteenMinsAgo).length;
  const activeToday = deviceList.filter(d => d.lastActive > oneDayAgo).length;

  return {
    activeNow: Math.max(activeNow, 1), // At least current active session
    activeToday: Math.max(activeToday, 1),
    totalDevices: Math.max(deviceList.length, 1),
    totalSessions: cachedAnalytics.totalSessions || 1,
    recentDevices: deviceList.sort((a, b) => b.lastActive - a.lastActive).slice(0, 10)
  };
}

module.exports = {
  loadCatalog,
  persistCatalog,
  loadIncomingScrapes,
  persistIncomingScrapes,
  loadRequests,
  persistRequests,
  loadAnalytics,
  recordDevicePing,
  getLiveAnalyticsSummary
};
