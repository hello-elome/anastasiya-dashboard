// Lokale Vorschau: node anastasiya-dashboard/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'docs');
const port = Number(process.env.PORT) || 4391;
const typen = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const pfad = decodeURIComponent(req.url.split('?')[0]);
  const datei = path.join(root, pfad === '/' ? 'index.html' : pfad);
  if (!datei.startsWith(root)) return res.writeHead(403).end();
  fs.readFile(datei, (err, inhalt) => {
    if (err) return res.writeHead(404).end('nicht gefunden');
    res.writeHead(200, { 'Content-Type': typen[path.extname(datei)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(inhalt);
  });
}).listen(port, () => console.log(`Dashboard auf http://localhost:${port}`));
