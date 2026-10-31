const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { testUrl, verifyAndEnhanceSubject } = require('./crawler_engine');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fox2026";
const PUBLIC_DIR = path.join(__dirname, 'public');

let viewerRequests = [
  { id: 1, title: "Game of Thrones", type: "مسلسل", year: "2019", notes: "يرجى توفير جميع المواسم بدقة 1080p", date: "منذ 10 دقائق", status: "pending" },
  { id: 2, title: "Inception", type: "فيلم", year: "2010", notes: "مترجم عربي عالي الجودة", date: "منذ ساعة", status: "pending" },
  { id: 3, title: "قيامة عثمان", type: "مسلسل", year: "2024", notes: "الحلقة 165 مترجمة", date: "منذ ساعتين", status: "pending" }
];

let publishedCatalog = [];
try {
  const extracted = JSON.parse(fs.readFileSync(path.join(__dirname, 'extracted_subjects.json'), 'utf8'));
  publishedCatalog = extracted.slice(0, 25);
} catch(e) {
  publishedCatalog = [];
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Static files (HTML, CSS, JS)
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(htmlPath));
    }
  }

  // API 1: Login
  if (pathname === '/api/login' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (password === ADMIN_PASSWORD) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, token: ADMIN_PASSWORD }));
        }
      } catch(e){}
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'رمز المرور غير صحيح' }));
    });
    return;
  }

  // Auth check for protected APIs
  const authHeader = req.headers['authorization'];
  if (pathname.startsWith('/api/') && authHeader !== ADMIN_PASSWORD) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'غير مصرح - يرجى تسجيل الدخول' }));
  }

  // API 2: Search MovieBox
  if (pathname === '/api/search-moviebox' && method === 'GET') {
    const q = (parsedUrl.query.q || '').toLowerCase();
    try {
      const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'extracted_subjects.json'), 'utf8'));
      const filtered = all.filter(s => 
        s.title.toLowerCase().includes(q) || 
        (s.genre && s.genre.toLowerCase().includes(q))
      ).slice(0, 24);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: filtered.length, results: filtered }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // API 3: Crawl & Publish (With Link Verification & HD Enhancement)
  if (pathname === '/api/crawl-publish' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const item = JSON.parse(body);
        const verifiedWork = await verifyAndEnhanceSubject(item);
        publishedCatalog.unshift(verifiedWork);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'تم فحص الروابط والزحف والنشر بنجاح!',
          item: verifiedWork
        }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'خطأ في معالجة العمل: ' + e.message }));
      }
    });
    return;
  }

  // API 3.5: Test & Verify Link
  if (pathname === '/api/verify-link' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        const result = await testUrl(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, result }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API 4: Requests
  if (pathname === '/api/requests' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, requests: viewerRequests }));
  }

  // API 5: Catalog
  if (pathname === '/api/catalog' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, catalog: publishedCatalog }));
  }

  if (pathname.startsWith('/api/catalog/') && method === 'DELETE') {
    const id = pathname.replace('/api/catalog/', '');
    publishedCatalog = publishedCatalog.filter(c => c.id !== id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'تم الحذف من التطبيق' }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

module.exports = server;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=== Cinema Fox Admin Dashboard running on http://localhost:${PORT} ===`);
    console.log(`Default Admin Password: ${ADMIN_PASSWORD}`);
  });
}
