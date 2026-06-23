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

function sse(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
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
  }, 118000);

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

  function failJson(status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    failJson(400, { error: 'Invalid JSON body' });
    cleanup();
    return;
  }

  const { endpoint, apiKey, model, messages, temperature } = body;
  if (!endpoint || !apiKey || !model || !messages) {
    failJson(400, { error: 'Missing endpoint, apiKey, model, or messages' });
    cleanup();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true);
  res.write(': start\n\n');

  keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 1000);

  try {
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
        sse(res, { error: { message: text || 'Upstream error ' + upstreamRes.status } });
      }
      if (!res.writableEnded) res.end();
      return;
    }
    upstreamReader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await upstreamReader.read();
      if (done) break;
      if (res.writableEnded) break;
      res.write(value);
    }
    finished = true;
  } catch (e) {
    console.error('proxy error:', e.message, { reason: abortReason });
    if (!res.writableEnded) {
      const message = abortReason === 'timeout'
        ? 'Generation timed out (118s limit). Try a faster model or lower detail level.'
        : (abortReason === 'client disconnected' ? 'Client disconnected.' : 'Proxy error: ' + e.message);
      sse(res, { error: { message } });
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
