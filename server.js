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
  if (token === ADMIN_PASSWORD) return true; // Direct master password bypass
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [b64, sig] = parts;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return false;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// -------------------------------------------------------------
// 2. MIME TYPE RESOLVER
// -------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// -------------------------------------------------------------
// 3. HTTP REQUEST ROUTER
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;
  const method = req.method;

  // Universal CORS headers
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

  const filePath = path.join(PUBLIC_DIR, pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(filePath));
  }

  // ===========================================================
  // PUBLIC API ENDPOINTS (For Flutter App & Anonymous Viewers)
  // ===========================================================

  // 1. Mobile App Live Catalog: GET /api/catalog
  if (pathname === '/api/catalog' && method === 'GET') {
    const catalog = await storage.loadCatalog();
    const visible = catalog.filter(c => !c.hidden);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(visible));
  }

  // 2. Viewer Request Submission: POST /api/requests
  if (pathname === '/api/requests' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'العنوان مطلوب' }));
        }

        const requests = await storage.loadRequests();
        const newReq = {
          id: Date.now().toString(),
          title: data.title,
          type: data.type || 'movie',
          deviceModel: data.deviceModel || 'Unknown Device',
          notes: data.notes || '',
          date: new Date().toISOString(),
          status: 'pending'
        };

        requests.unshift(newReq);
        await storage.persistRequests(requests);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم إرسال طلبك بنجاح وسيقوم المشرف بفحصه وإضافته قريباً',
          request: newReq
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'صيغة غير صالحة' }));
      }
    });
    return;
  }

  // 3. Device Analytics Heartbeat: POST /api/analytics/ping
  if (pathname === '/api/analytics/ping' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const info = JSON.parse(body);
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        storage.recordDevicePing({ ...info, ip: ip.split(',')[0].trim() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, timestamp: Date.now() }));
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // 4. Admin Login: POST /api/login
  if (pathname === '/api/login' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
          const token = generateToken(username);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            token,
            user: { username: ADMIN_USER, role: 'super_admin' },
            message: 'تم تسجيل الدخول بنجاح'
          }));
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'طلب غير صالح' }));
      }
    });
    return;
  }

  // ===========================================================
  // PROTECTED ADMIN ENDPOINTS
  // ===========================================================
  const authHeader = req.headers['authorization'];
  let authToken = '';
  if (authHeader) {
    authToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  }

  if (!verifyToken(authToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'غير مصرح - الرجاء تسجيل الدخول أولاً' }));
  }

  // Admin Dashboard Statistics: GET /api/admin/stats
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const catalog = await storage.loadCatalog();
    const requests = await storage.loadRequests();
    const incoming = await storage.loadIncomingScrapes();
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
        incomingDesktopScrapes: incoming.length,
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

  // Admin Crawl & Publish Directly: POST /api/admin/crawl-publish
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

  // ===========================================================
  // DESKTOP APP INBOX SYNC & PUBLISHING WORKFLOW
  // ===========================================================

  // 1. Receive Scraped Works from MovieBox Desktop: POST /api/admin/desktop-sync
  if (pathname === '/api/admin/desktop-sync' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const works = Array.isArray(data) ? data : [data];
        let incoming = await storage.loadIncomingScrapes();

        for (const w of works) {
          const itemKey = w.subjectId || w.id || w.title;
          const cleanItem = {
            id: itemKey ? String(itemKey) : Date.now().toString(),
            subjectId: w.subjectId || w.id || '',
            title: w.title || 'عمل جديد',
            titleAr: w.titleAr || w.title || 'عمل جديد',
            cover: w.cover || 'assets/images/logo.png',
            backdrop: w.backdrop || w.cover || 'assets/images/logo.png',
            videoUrl: w.videoUrl || '',
            resolution: w.resolution || '1080p',
            imdbRating: w.imdbRating || w.rating || '7.5',
            genre: w.genre || 'أكشن',
            type: w.type || 'movie',
            releaseDate: w.releaseDate || w.year || '2026',
            subtitles: w.subtitles || [],
            source: 'MovieBox Desktop App',
            status: 'pending_review',
            scrapedAt: new Date().toISOString()
          };

          // Deduplicate in incoming queue
          incoming = incoming.filter(i => i.id !== cleanItem.id && i.title !== cleanItem.title);
          incoming.unshift(cleanItem);
        }

        await storage.persistIncomingScrapes(incoming);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          count: works.length,
          incomingTotal: incoming.length,
          message: `تم استلام ${works.length} عمل من MovieBox الحاسبة وحفظها في الوارد للمراجعة والنشر!`
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 2. Fetch Incoming Scrapes: GET /api/admin/desktop-scrapes
  if (pathname === '/api/admin/desktop-scrapes' && method === 'GET') {
    const incoming = await storage.loadIncomingScrapes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, count: incoming.length, scrapes: incoming }));
  }

  // 3. Publish Single Incoming Work to Cinema Fox: POST /api/admin/desktop-scrapes/publish
  if (pathname === '/api/admin/desktop-scrapes/publish' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        let incoming = await storage.loadIncomingScrapes();
        const target = incoming.find(s => s.id === id || s.subjectId === id);
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'العمل غير موجود في قائمة الوارد' }));
        }

        // Verify & enhance (tests 1080p stream, covers, ensures production quality)
        const verified = await verifyAndEnhanceSubject(target);

        // Add to main catalog
        let catalog = await storage.loadCatalog();
        catalog = catalog.filter(c => c.id !== verified.id && c.title !== verified.title);
        catalog.unshift(verified);
        await storage.persistCatalog(catalog);

        // Remove from incoming queue
        incoming = incoming.filter(s => s.id !== id && s.subjectId !== id);
        await storage.persistIncomingScrapes(incoming);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          published: verified,
          remainingIncoming: incoming.length,
          message: `تم نشر "${verified.title}" في تطبيق سينما فوكس بنجاح وهو متاح للمشاهدين الآن!`
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 4. Publish ALL Incoming Works in Bulk: POST /api/admin/desktop-scrapes/publish-all
  if (pathname === '/api/admin/desktop-scrapes/publish-all' && method === 'POST') {
    let incoming = await storage.loadIncomingScrapes();
    if (incoming.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: 0, message: 'لا توجد أعمال واردة جديدة للنشر' }));
    }

    let catalog = await storage.loadCatalog();
    let publishedCount = 0;

    for (const item of incoming) {
      const verified = await verifyAndEnhanceSubject(item);
      catalog = catalog.filter(c => c.id !== verified.id && c.title !== verified.title);
      catalog.unshift(verified);
      publishedCount++;
    }

    await storage.persistCatalog(catalog);
    await storage.persistIncomingScrapes([]); // Clear queue

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      count: publishedCount,
      message: `تم نشر جميع الأعمال الواردة (${publishedCount} عمل) في تطبيق سينما فوكس بنجاح!`
    }));
  }

  // 5. Delete an Incoming Work from Queue: DELETE /api/admin/desktop-scrapes/:id
  if (pathname.startsWith('/api/admin/desktop-scrapes/') && method === 'DELETE') {
    const id = pathname.replace('/api/admin/desktop-scrapes/', '');
    let incoming = await storage.loadIncomingScrapes();
    const initialLen = incoming.length;
    incoming = incoming.filter(s => s.id !== id && s.subjectId !== id);
    await storage.persistIncomingScrapes(incoming);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      deleted: incoming.length < initialLen,
      remaining: incoming.length,
      message: 'تم إزالة العمل من قائمة الوارد'
    }));
  }

  // 6. Clear All Incoming Scrapes: POST /api/admin/desktop-scrapes/clear
  if (pathname === '/api/admin/desktop-scrapes/clear' && method === 'POST') {
    await storage.persistIncomingScrapes([]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'تم إفراغ قائمة الأعمال الواردة بالكامل' }));
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
