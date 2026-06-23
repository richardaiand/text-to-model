const http = require("http");
const fs = require("fs");
const path = require("path");

process.on("uncaughtException", (e) => console.error("uncaught:", e?.stack || e.message || e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.stack || e?.message || e));

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/api/chat" && req.method === "POST") {
    return handleChatProxy(req, res);
  }

  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += Buffer.byteLength(c, "utf8");
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleChatProxy(req, res) {
  let upstreamReader = null;
  let keepAlive = null;
  let upstreamRes = null;
  let finished = false;
  let abortReason = null;
  const abort = new AbortController();
  const upstreamTimeout = setTimeout(() => {
    abortReason = "timeout";
    abort.abort();
  }, 29000);

  const cleanup = () => {
    clearTimeout(upstreamTimeout);
    if (keepAlive) clearInterval(keepAlive);
    req.off("close", onReqClose);
    req.off("error", onReqError);
    if (!finished) {
      try { abort.abort(); } catch {}
    }
  };

  const onReqClose = () => {
    if (!finished) {
      abortReason = abortReason || "client disconnected";
      abort.abort();
    }
  };
  const onReqError = (err) => {
    if (!finished) {
      abortReason = abortReason || (err?.message || "request error");
      abort.abort();
    }
  };

  req.on("close", onReqClose);
  req.on("error", onReqError);

  try {
    const body = JSON.parse(await readBody(req));
    const { endpoint, apiKey, model, messages, temperature } = body;
    if (!endpoint || !apiKey || !model || !messages) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing endpoint, apiKey, model, or messages" }));
      cleanup();
      return;
    }
    const base = String(endpoint).replace(/\/+$/, "");
    upstreamRes = await fetch(base + "/chat/completions", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({ model, messages, temperature: temperature ?? 0.7, stream: true }),
    });
    if (!upstreamRes.ok || !upstreamRes.body) {
      finished = true;
      const text = await upstreamRes.text().catch(() => "");
      cleanup();
      if (!res.writableEnded) {
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(text || JSON.stringify({ error: "Upstream error" }));
      }
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "Connection": "keep-alive",
    });
    upstreamReader = upstreamRes.body.getReader();
    keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": keep-alive\n\n");
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
    console.error("proxy error:", e.message, { reason: abortReason });
    if (res.headersSent && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: abortReason === "timeout" ? "Generation timed out (29s limit). Try a faster model." : "Generation aborted." } })}\n\n`);
    } else if (!res.headersSent && !res.writableEnded) {
      res.writeHead(502, { "Content-Type": "application/json" });
      const message = abortReason === "timeout"
        ? "Generation timed out (29s limit). Try a faster model like DeepSeek v4 Flash."
        : (abortReason === "client disconnected" ? "Client disconnected." : "Proxy error: " + e.message);
      res.end(JSON.stringify({ error: { message } }));
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

server.listen(PORT, () => {
  console.log(`text-to-model serving on port ${PORT}`);
});
