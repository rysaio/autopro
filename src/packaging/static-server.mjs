import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(root, "apps", "web", "dist");
const apiHost = process.env.SECOPS_API_HOST || "127.0.0.1";
const apiPort = Number(process.env.SECOPS_API_PORT || 4317);
const port = Number(process.env.SECOPS_WEB_PORT || 5317);
const host = process.env.SECOPS_WEB_HOST || "127.0.0.1";

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".json", "application/json; charset=utf-8"]
]);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (req.url.startsWith("/api/")) {
    proxyApi(req, res);
    return;
  }
  const url = new URL(req.url, `http://${host}:${port}`);
  const cleanPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const requested = path.resolve(webRoot, cleanPath || "index.html");
  const candidate = requested.startsWith(webRoot) && existsSync(requested) ? requested : path.join(webRoot, "index.html");
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime.get(path.extname(candidate).toLowerCase()) || "application/octet-stream",
      "Cache-Control": candidate.endsWith("index.html") ? "no-store" : "public, max-age=3600"
    });
    createReadStream(candidate).pipe(res);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`SecOps Web listening on http://${host}:${port}`);
});

function proxyApi(req, res) {
  const proxy = http.request({
    host: apiHost,
    port: apiPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${apiHost}:${apiPort}` }
  }, (apiRes) => {
    res.writeHead(apiRes.statusCode || 502, apiRes.headers);
    apiRes.pipe(res);
  });
  proxy.on("error", (error) => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`API proxy failed: ${error.message}`);
  });
  req.pipe(proxy);
}
