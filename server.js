const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { testUrl, verifyAndEnhanceSubject } = require('./crawler_engine');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "fox_admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Fox@2026#Secured!MasterKey";
const SECRET_KEY = process.env.SECRET_KEY || "FoxSecuredCinemaTokenKey_998877_2026";
const PUBLIC_DIR = path.join(__dirname, 'public');

// Active session tokens cache: token -> { user, createdAt, expiresAt }
const activeTokens = new Map();

// Helper: Generate a secure session token
function generateToken(user) {
  const timestamp = Date.now();
  const signature = crypto.createHmac('sha256', SECRET_KEY)
    .update(`${user}:${timestamp}:${crypto.randomBytes(16).toString('hex')}`)
    .digest('hex');
  const expiresAt = timestamp + (7 * 24 * 60 * 60 * 1000); // 7 days
  activeTokens.set(signature, { user, createdAt: timestamp, expiresAt });
  return { token: signature, expiresAt };
}

// Helper: Verify session token
function verifyToken(token) {
  if (!token) return false;
  // Also accept direct ADMIN_PASSWORD for CLI or automated scripts
  if (token === ADMIN_PASSWORD) return true;
  const session = activeTokens.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

// In-Memory Data Store (Initialized from extracted_subjects.json)
let viewerRequests = [
  { id: "req_1", title: "Game of Thrones", type: "مسلسل", year: "2019", notes: "يرجى توفير جميع المواسم بدقة 1080p مع الترجمة العربية", date: "منذ 15 دقيقة", status: "pending" },
  { id: "req_2", title: "Inception", type: "فيلم", year: "2010", notes: "مترجم عربي عالي الجودة Full HD", date: "منذ ساعة", status: "pending" },
  { id: "req_3", title: "قيامة عثمان", type: "مسلسل", year: "2024", notes: "الحلقة 165 مترجمة حصرياً", date: "منذ ساعتين", status: "pending" }
];

let publishedCatalog = [];
try {
  const extractedPath = path.join(__dirname, 'extracted_subjects.json');
  if (fs.existsSync(extractedPath)) {
    const extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
    publishedCatalog = extracted.slice(0, 30).map((item, idx) => ({
      ...item,
      id: item.subjectId || `work_${idx + 1}`,
      titleAr: item.titleAr || item.title,
      hidden: false,
      featured: idx < 4,
      publishedAt: new Date(Date.now() - (idx * 3600000)).toISOString()
    }));
  }
} catch(e) {
  publishedCatalog = [];
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers for Web & Flutter Mobile App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Static Frontend (HTML, Tailwind CSS, JS)
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  // -------------------------------------------------------------
  // 1. PUBLIC ENDPOINTS (No Token Needed - For Flutter Mobile App)
  // -------------------------------------------------------------

  // Health check
  if (pathname === '/api/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'Cinema Fox Cloud API',
      version: '2.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  }

  // Public Catalog: GET /api/catalog
  if (pathname === '/api/catalog' && method === 'GET') {
    const typeFilter = parsedUrl.query.type;
    const searchFilter = (parsedUrl.query.q || '').toLowerCase();

    let items = publishedCatalog.filter(i => !i.hidden);

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
    const found = publishedCatalog.find(c => c.id === id || c.subjectId === id);
    if (found) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, item: found }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'العمل غير موجود' }));
    }
  }

  // Public Viewer Request: POST /api/requests (From Flutter App "طلب عمل")
  if (pathname === '/api/requests' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const title = (data.title || '').trim();
        if (!title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'عنوان العمل مطلوب' }));
        }

        const newRequest = {
          id: `req_${Date.now()}`,
          title: title,
          type: data.type || 'فيلم',
          year: data.year || '2026',
          notes: data.notes || '',
          date: 'الآن',
          status: 'pending',
          submittedAt: new Date().toISOString()
        };

        viewerRequests.unshift(newRequest);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم استلام طلبك بنجاح! سيتم مراجعته والزحف عليه قريباً.',
          request: newRequest
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'صيغة بيانات غير صحيحة' }));
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
        const userMatches = (!username || username === ADMIN_USER);
        const passMatches = (password === ADMIN_PASSWORD);

        if (userMatches && passMatches) {
          const { token, expiresAt } = generateToken(ADMIN_USER);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            token,
            user: ADMIN_USER,
            expiresAt
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'اسم المستخدم أو رمز المرور غير صحيح' }));
        }
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'صيغة غير صحيحة' }));
      }
    });
    return;
  }

  // -------------------------------------------------------------
  // 2. PROTECTED ADMIN ENDPOINTS (Require Bearer Token)
  // -------------------------------------------------------------

  const rawAuth = req.headers['authorization'] || '';
  const token = rawAuth.replace(/^Bearer\s+/i, '').trim();

  if (!verifyToken(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'غير مصرح - يرجى تسجيل الدخول برمز الإدارة الصحيح' }));
  }

  // Admin Stats: GET /api/admin/stats
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const totalWorks = publishedCatalog.length;
    const totalMovies = publishedCatalog.filter(c => c.type !== 'series').length;
    const totalSeries = publishedCatalog.filter(c => c.type === 'series').length;
    const pendingReqs = viewerRequests.filter(r => r.status === 'pending').length;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      stats: {
        totalWorks,
        totalMovies,
        totalSeries,
        pendingRequests: pendingReqs,
        totalRequests: viewerRequests.length,
        systemStatus: 'Online (24/7 Cloud Secured)',
        crawlerActive: true
      }
    }));
  }

  // Admin Full Catalog View: GET /api/admin/catalog
  if (pathname === '/api/admin/catalog' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, count: publishedCatalog.length, catalog: publishedCatalog }));
  }

  // Admin Toggle Visibility: POST /api/admin/catalog/toggle
  if (pathname === '/api/admin/catalog/toggle' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const item = publishedCatalog.find(c => c.id === id || c.subjectId === id);
        if (item) {
          item.hidden = !item.hidden;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, hidden: item.hidden }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'العمل غير موجود' }));
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
    const initialLen = publishedCatalog.length;
    publishedCatalog = publishedCatalog.filter(c => c.id !== id && c.subjectId !== id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      deleted: publishedCatalog.length < initialLen,
      message: 'تم حذف العمل من التطبيق'
    }));
  }

  // Admin Search MovieBox: GET /api/search-moviebox or /api/admin/search-moviebox
  if ((pathname === '/api/search-moviebox' || pathname === '/api/admin/search-moviebox') && method === 'GET') {
    const q = (parsedUrl.query.q || '').toLowerCase();
    try {
      const extractedPath = path.join(__dirname, 'extracted_subjects.json');
      const all = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
      const filtered = all.filter(s => 
        s.title.toLowerCase().includes(q) || 
        (s.genre && s.genre.toLowerCase().includes(q)) ||
        (s.titleAr && s.titleAr.toLowerCase().includes(q))
      ).slice(0, 30);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: filtered.length, results: filtered }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Admin Crawl & Publish: POST /api/crawl-publish or /api/admin/crawl-publish
  if ((pathname === '/api/crawl-publish' || pathname === '/api/admin/crawl-publish') && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const item = JSON.parse(body);
        const verifiedWork = await verifyAndEnhanceSubject(item);
        
        // Remove existing if duplicate
        publishedCatalog = publishedCatalog.filter(c => c.id !== verifiedWork.id && c.subjectId !== verifiedWork.subjectId);
        publishedCatalog.unshift(verifiedWork);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم فحص روابط الـ HD والزحف والنشر بنجاح!',
          item: verifiedWork
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'خطأ في معالجة العمل: ' + e.message }));
      }
    });
    return;
  }

  // Admin Link Verification: POST /api/verify-link or /api/admin/verify-link
  if ((pathname === '/api/verify-link' || pathname === '/api/admin/verify-link') && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url: targetUrl } = JSON.parse(body);
        const result = await testUrl(targetUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, result }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Admin Viewer Requests: GET /api/admin/requests
  if ((pathname === '/api/admin/requests' || pathname === '/api/requests') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, requests: viewerRequests }));
  }

  // Admin Resolve Request: POST /api/admin/requests/resolve
  if (pathname === '/api/admin/requests/resolve' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, status } = JSON.parse(body);
        const reqItem = viewerRequests.find(r => r.id === id);
        if (reqItem) {
          reqItem.status = status || 'completed';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'تم تحديث حالة الطلب' }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'الطلب غير موجود' }));
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
    console.log(`=== Cinema Fox Secured Admin Dashboard running on http://localhost:${PORT} ===`);
    console.log(`Admin User: ${ADMIN_USER}`);
    console.log(`Admin Password: ${ADMIN_PASSWORD}`);
  });
}
