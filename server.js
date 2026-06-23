const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  console.log('[REQ]', req.method, req.url);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok: ' + req.url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('minimal server listening on port', PORT);
});
