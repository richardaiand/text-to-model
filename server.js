const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
  '.obj': 'text/plain',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function proxyChat(req, res) {
  let upstreamReader = null;
  let keepAlive = null;
  let upstreamRes = null;
  let finished = false;
  let abortReason = null;
  const abort = new AbortController();
  const upstreamTimeout = setTimeout(() => {
    abortReason = 'timeout';
    abort.abort();
  }, 29000);

  const cleanup = () => {
    clearTimeout(upstreamTimeout);
    if (keepAlive) clearInterval(keepAlive);
    req.off('close', onReqClose);
    req.off('error', onReqError);
    if (!finished) {
      try { abort.abort(); } catch {}
    }
  };

  const onReqClose = () => {
    if (!finished) {
      abortReason = abortReason || 'client disconnected';
      abort.abort();
    }
  };
  const onReqError = (err) => {
    if (!finished) {
      abortReason = abortReason || (err?.message || 'request error');
      abort.abort();
    }
  };

  req.on('close', onReqClose);
  req.on('error', onReqError);

  function sendJson(status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  try {
    const { endpoint, apiKey, model, messages, temperature } = await readBody(req);
    if (!endpoint || !apiKey || !model || !messages) {
      sendJson(400, { error: 'Missing endpoint, apiKey, model, or messages' });
      cleanup();
      return;
    }
    const base = String(endpoint).replace(/\/+$/, '');
    upstreamRes = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, stream: true }),
    });
    if (!upstreamRes.ok || !upstreamRes.body) {
      finished = true;
      const text = await upstreamRes.text().catch(() => '');
      cleanup();
      if (!res.writableEnded) {
        const body = text || JSON.stringify({ error: 'Upstream error' });
        res.writeHead(upstreamRes.status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });
    upstreamReader = upstreamRes.body.getReader();
    keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    }, 5000);
    while (true) {
      const { done, value } = await upstreamReader.read();
      if (done) break;
      if (res.writableEnded) break;
      res.write(value);
    }
    finished = true;
  } catch (e) {
    console.error('proxy error:', e.message, { reason: abortReason });
    if (res.headersSent && !res.writableEnded) {
      const message = abortReason === 'timeout'
        ? 'Generation timed out (29s limit). Try a faster model.'
        : 'Generation aborted.';
      res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`);
    } else if (!res.headersSent && !res.writableEnded) {
      const message = abortReason === 'timeout'
        ? 'Generation timed out (29s limit). Try a faster model like DeepSeek v4 Flash.'
        : (abortReason === 'client disconnected' ? 'Client disconnected.' : 'Proxy error: ' + e.message);
      sendJson(502, { error: { message } });
    }
  } finally {
    cleanup();
    if (upstreamReader) {
      try { await upstreamReader.cancel(); } catch {}
    }
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (!res.writableEnded) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    proxyChat(req, res);
    return;
  }

  if (pathname.startsWith('/src/')) {
    const filePath = path.join(__dirname, pathname);
    if (!filePath.startsWith(path.join(__dirname, 'src'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    serveFile(res, filePath);
    return;
  }

  serveFile(res, path.join(__dirname, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`text-to-model serving on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
