import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2 * 1024 * 1024' }));

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

  try {
    const { endpoint, apiKey, model, messages, temperature } = req.body;
    if (!endpoint || !apiKey || !model || !messages) {
      res.status(400).json({ error: 'Missing endpoint, apiKey, model, or messages' });
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
        res.status(upstreamRes.status).send(text || JSON.stringify({ error: 'Upstream error' }));
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
      res.status(502).json({ error: { message } });
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

app.post('/api/chat', proxyChat);

app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`text-to-model serving on port ${PORT}`);
});
