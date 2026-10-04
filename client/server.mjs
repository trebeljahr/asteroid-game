/**
 * Lightweight production server for the Vite-built SPA.
 *
 * Serves static files from ./dist and proxies /socket.io/* and /trpc/*
 * to the backend at runtime via BACKEND_URL, so the Docker image doesn't
 * need to be rebuilt when the backend address changes.
 *
 * Usage:
 *   BACKEND_URL=http://server:9777 node server.mjs
 *
 * BACKEND_URL is the address of the game server as this container can
 * reach it. In Docker Compose that is the service name
 * (http://server:9777). When the client runs as its own image app, set it
 * to the server app's routed or internal URL; NODE_ENV=production refuses
 * to start without it, instead of silently proxying to 127.0.0.1.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, join, resolve } from "node:path";
import { parse } from "node:url";

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

const port = Number.parseInt(process.env.PORT || "80", 10);
if (!process.env.BACKEND_URL && process.env.NODE_ENV === "production") {
  console.error("BACKEND_URL must be set to the game server URL (for example http://server:9777).");
  process.exit(1);
}
const backendTarget =
  process.env.BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "9777"}`;
const backendUrl = new URL(backendTarget);
const isHttps = backendUrl.protocol === "https:";
const makeRequest = isHttps ? httpsRequest : httpRequest;
const distDir = resolve("./dist");
let draining = false;

function serveStaticFile(res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const filePath = resolve(join(distDir, decodedPath));
  if (!filePath.startsWith(distDir + "/") && filePath !== distDir) {
    return false;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const isHashed = /\.[a-f0-9]{8,}\.\w+$/.test(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": statSync(filePath).size,
    "Cache-Control": isHashed
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

function proxyRequest(req, res) {
  const proxyReq = makeRequest(
    {
      hostname: backendUrl.hostname,
      port: backendUrl.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: backendUrl.host },
    },
    (proxyRes) => {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        const loc = proxyRes.headers.location;
        if (loc.startsWith(backendTarget)) {
          proxyRes.headers.location = loc.replace(backendTarget, "");
        }
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on("error", (err) => {
    console.error(`Failed to proxy ${req.url}`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad Gateway" }));
    }
  });

  req.pipe(proxyReq, { end: true });
}

function proxyWebSocketUpgrade(req, socket, head) {
  const proxyReq = makeRequest({
    hostname: backendUrl.hostname,
    port: backendUrl.port || (isHttps ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: backendUrl.host },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const responseLines = [`HTTP/1.1 101 ${proxyRes.statusMessage || "Switching Protocols"}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) responseLines.push(`${key}: ${v}`);
      } else if (value != null) {
        responseLines.push(`${key}: ${value}`);
      }
    }
    socket.write(responseLines.join("\r\n") + "\r\n\r\n");

    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.on("end", () => socket.end());
    socket.on("end", () => proxySocket.end());
  });

  proxyReq.on("response", (proxyRes) => {
    const responseLines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) responseLines.push(`${key}: ${v}`);
      } else if (value != null) {
        responseLines.push(`${key}: ${value}`);
      }
    }
    socket.write(responseLines.join("\r\n") + "\r\n\r\n");
    proxyRes.pipe(socket);
  });

  proxyReq.on("error", (err) => {
    console.error(`Failed to proxy WebSocket upgrade ${req.url}`, err.message);
    socket.destroy();
  });

  proxyReq.end();
}

const indexPath = join(distDir, "index.html");

const httpServer = createServer((req, res) => {
  const { pathname } = parse(req.url, true);

  if (pathname.startsWith("/socket.io/") || pathname.startsWith("/trpc/")) {
    proxyRequest(req, res);
    return;
  }

  if (pathname === "/health" || pathname === "/healthz") {
    res.writeHead(draining ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: !draining }));
    return;
  }

  if (serveStaticFile(res, pathname)) {
    return;
  }

  // SPA fallback — serve index.html for all other routes
  if (existsSync(indexPath)) {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "public, max-age=0, must-revalidate",
    });
    createReadStream(indexPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url, true);

  if (pathname.startsWith("/socket.io/")) {
    proxyWebSocketUpgrade(req, socket, head);
  }
});

httpServer.listen(port, () => {
  console.log(`> Client ready on http://localhost:${port} (backend: ${backendTarget})`);
});

process.on("SIGTERM", () => {
  if (draining) return;
  draining = true;
  setTimeout(() => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }, 20_000);
});
