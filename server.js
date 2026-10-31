const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { testUrl, verifyAndEnhanceSubject } = require('./crawler_engine');
const storage = require('./storage_manager');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "fox_admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Fox@2026#Secured!MasterKey";
const JWT_SECRET = process.env.SECRET_KEY || "FoxSecuredCinemaTokenKey_998877_2026";
const PUBLIC_DIR = path.join(__dirname, 'public');

// -------------------------------------------------------------
// 1. STATELESS HMAC-SHA256 TOKEN AUTHENTICATION (Never logs out!)
// -------------------------------------------------------------
function generateToken(user) {
  const payload = {
    u: user,
    exp: Date.now() + (365 * 24 * 60 * 60 * 1000) // Valid for 1 full year
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  if (token === ADMIN_PASSWORD) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [b64, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return false;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return Date.now() < payload.exp;
  } catch(e) {
    return false;
  }
}

// -------------------------------------------------------------
// 2. HTTP SERVER HANDLER
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Static Frontend (HTML, CSS, JS)
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  // -------------------------------------------------------------
  // PUBLIC ENDPOINTS (Flutter App & Viewers)
  // -------------------------------------------------------------

  // Health Check
  if (pathname === '/api/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'Cinema Fox Cloud API',
      version: '3.0.0-production',
      timestamp: new Date().toISOString()
    }));
  }

  // Mobile App Active Ping (Analytics)
  if (pathname === '/api/analytics/ping' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const deviceInfo = JSON.parse(body);
        storage.recordDevicePing(deviceInfo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, timestamp: Date.now() }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Public Catalog: GET /api/catalog
  if (pathname === '/api/catalog' && method === 'GET') {
    const catalog = await storage.loadCatalog();
    const typeFilter = parsedUrl.query.type;
    const searchFilter = (parsedUrl.query.q || '').toLowerCase();

    let items = catalog.filter(i => !i.hidden);

    if (typeFilter) {
      items = items.filter(i => (i.type || '').toLowerCase() === typeFilter.toLowerCase());
    }

    if (searchFilter) {
      items = items.filter(i => 
        (i.title || '').toLowerCase().includes(searchFilter) ||
        (i.titleAr || '').toLowerCase().includes(searchFilter)
      );
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      count: items.length,
      catalog: items
    }));
  }

  // Public Single Item: GET /api/catalog/:id
  if (pathname.startsWith('/api/catalog/') && method === 'GET' && !pathname.includes('/toggle')) {
    const id = pathname.replace('/api/catalog/', '');
    const catalog = await storage.loadCatalog();
    const found = catalog.find(c => c.id === id || c.subjectId === id);
    if (found) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, item: found }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'العمل غير موجود' }));
    }
  }

  // Public Viewer Request: POST /api/requests (From Flutter "طلب عمل")
  if (pathname === '/api/requests' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const title = (data.title || '').trim();
        if (!title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'عنوان العمل مطلوب' }));
        }

        const requests = await storage.loadRequests();
        const newReq = {
          id: `req_${Date.now()}`,
          title: title,
          type: data.type || 'فيلم',
          year: data.year || '2026',
          notes: data.notes || '',
          date: 'الآن',
          status: 'pending',
          submittedAt: new Date().toISOString()
        };

        requests.unshift(newReq);
        await storage.persistRequests(requests);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم استلام طلبك بنجاح! سيتم مراجعته وتوفيره قريباً.',
          request: newReq
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin Login: POST /api/login
  if (pathname === '/api/login' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        const userMatches = (username === ADMIN_USER);
        const passMatches = (password === ADMIN_PASSWORD);

        if (userMatches && passMatches) {
          const token = generateToken(ADMIN_USER);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            token,
            user: ADMIN_USER
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'اسم المستخدم أو رمز المرور غير صحيح' }));
        }
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // -------------------------------------------------------------
  // PROTECTED ADMIN ENDPOINTS (Require Bearer Token)
  // -------------------------------------------------------------

  const rawAuth = req.headers['authorization'] || '';
  const token = rawAuth.replace(/^Bearer\s+/i, '').trim();

  if (!verifyToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'غير مصرح - يرجى تسجيل الدخول برمز الإدارة الصحيح' }));
  }

  // Admin Stats: GET /api/admin/stats
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const catalog = await storage.loadCatalog();
    const requests = await storage.loadRequests();
    const analytics = storage.getLiveAnalyticsSummary();

    const totalWorks = catalog.length;
    const totalMovies = catalog.filter(c => c.type !== 'series').length;
    const totalSeries = catalog.filter(c => c.type === 'series').length;
    const pendingReqs = requests.filter(r => r.status === 'pending').length;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      stats: {
        totalWorks,
        totalMovies,
        totalSeries,
        pendingRequests: pendingReqs,
        totalRequests: requests.length,
        activeNow: analytics.activeNow,
        activeToday: analytics.activeToday,
        totalDevices: analytics.totalDevices,
        totalSessions: analytics.totalSessions
      }
    }));
  }

  // Admin Live Analytics: GET /api/admin/analytics
  if (pathname === '/api/admin/analytics' && method === 'GET') {
    const analytics = storage.getLiveAnalyticsSummary();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, analytics }));
  }

  // Admin Full Catalog: GET /api/admin/catalog
  if (pathname === '/api/admin/catalog' && method === 'GET') {
    const catalog = await storage.loadCatalog();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, count: catalog.length, catalog }));
  }

  // Admin Toggle Visibility: POST /api/admin/catalog/toggle
  if (pathname === '/api/admin/catalog/toggle' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        const catalog = await storage.loadCatalog();
        const item = catalog.find(c => c.id === id || c.subjectId === id);
        if (item) {
          item.hidden = !item.hidden;
          await storage.persistCatalog(catalog);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, hidden: item.hidden }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'العمل غير موجود' }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin Delete Work: DELETE /api/admin/catalog/:id
  if (pathname.startsWith('/api/admin/catalog/') && method === 'DELETE') {
    const id = pathname.replace('/api/admin/catalog/', '');
    let catalog = await storage.loadCatalog();
    const initialLen = catalog.length;
    catalog = catalog.filter(c => c.id !== id && c.subjectId !== id);
    await storage.persistCatalog(catalog);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      deleted: catalog.length < initialLen,
      message: 'تم حذف العمل نهائياً وحفظ التغييرات سحابياً'
    }));
  }

  // Admin Search MovieBox: GET /api/admin/search-moviebox
  if ((pathname === '/api/search-moviebox' || pathname === '/api/admin/search-moviebox') && method === 'GET') {
    const q = (parsedUrl.query.q || '').toLowerCase();
    try {
      const extractedPath = path.join(__dirname, 'extracted_subjects.json');
      const all = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
      const filtered = all.filter(s => 
        (s.title || '').toLowerCase().includes(q) || 
        (s.genre && s.genre.toLowerCase().includes(q)) ||
        (s.titleAr && s.titleAr.toLowerCase().includes(q))
      ).slice(0, 50);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: filtered.length, results: filtered }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Admin Crawl & Publish: POST /api/admin/crawl-publish
  if ((pathname === '/api/crawl-publish' || pathname === '/api/admin/crawl-publish') && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const item = JSON.parse(body);
        const verifiedWork = await verifyAndEnhanceSubject(item);
        
        let catalog = await storage.loadCatalog();
        catalog = catalog.filter(c => c.id !== verifiedWork.id && c.subjectId !== verifiedWork.subjectId);
        catalog.unshift(verifiedWork);
        await storage.persistCatalog(catalog);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم فحص روابط الـ HD والزحف والنشر والحفظ السحابي بنجاح!',
          item: verifiedWork
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'خطأ في معالجة العمل: ' + e.message }));
      }
    });
    return;
  }

  // Admin Desktop Direct Sync: POST /api/admin/desktop-sync
  if (pathname === '/api/admin/desktop-sync' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const works = Array.isArray(data) ? data : [data];
        let catalog = await storage.loadCatalog();

        for (const w of works) {
          const verified = await verifyAndEnhanceSubject(w);
          catalog = catalog.filter(c => c.id !== verified.id && c.subjectId !== verified.subjectId);
          catalog.unshift(verified);
        }

        await storage.persistCatalog(catalog);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          count: works.length,
          message: `تم استيراد ${works.length} عمل من MovieBox Desktop بدقة 1080p وحفظها بنجاح!`
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin Viewer Requests: GET /api/admin/requests
  if ((pathname === '/api/admin/requests' || pathname === '/api/requests') && method === 'GET') {
    const requests = await storage.loadRequests();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, requests }));
  }

  // Admin Resolve Request: POST /api/admin/requests/resolve
  if (pathname === '/api/admin/requests/resolve' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id, status: newStatus } = JSON.parse(body);
        const requests = await storage.loadRequests();
        const reqItem = requests.find(r => r.id === id);
        if (reqItem) {
          reqItem.status = newStatus || 'completed';
          await storage.persistRequests(requests);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'تم تحديث حالة الطلب وحفظها' }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'الطلب غير موجود' }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
});

module.exports = server;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=== Cinema Fox Persistent Admin running on http://localhost:${PORT} ===`);
  });
}
