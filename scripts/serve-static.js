const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { buildStaticData } = require("./build-static-data");

const OREF_PROXY_ROUTES = {
  "/api/oref/alerts":  "https://www.oref.org.il/warningMessages/alert/Alerts.json",
  "/api/oref/history": "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json",
};

function proxyOref(targetUrl, res) {
  const url = new URL(targetUrl + "?" + Math.round(Date.now() / 1000));
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "GET",
    headers: {
      "Pragma": "no-cache",
      "Cache-Control": "max-age=0",
      "Referer": "https://www.oref.org.il/12481-he/Pakar.aspx",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36",
    },
  };

  const proxyRes = https.request(options, (upstream) => {
    const chunks = [];
    upstream.on("data", (c) => chunks.push(c));
    upstream.on("end", () => {
      res.writeHead(upstream.statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(Buffer.concat(chunks));
    });
  });

  proxyRes.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error: " + err.message);
  });

  proxyRes.end();
}

const PORT = Number(process.env.PORT || 8080);
const AUTO_REFRESH_SECONDS = Number(process.env.AUTO_REFRESH_SECONDS || 0);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function getSafePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(PUBLIC_DIR, clean));
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  // Handle OPTIONS preflight for proxy routes
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
    res.end();
    return;
  }

  // oref proxy routes
  const routeKey = (req.url || "").split("?")[0];
  if (OREF_PROXY_ROUTES[routeKey]) {
    proxyOref(OREF_PROXY_ROUTES[routeKey], res);
    return;
  }

  const filePath = getSafePath(req.url || "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
      } else {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal server error");
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Static site running: http://localhost:${PORT}`);
  if (AUTO_REFRESH_SECONDS > 0) {
    console.log(`Auto-refreshing API data every ${AUTO_REFRESH_SECONDS} seconds`);
  }
});

let refreshInProgress = false;

async function refreshData() {
  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;
  try {
    await buildStaticData();
  } catch (err) {
    console.error(`Auto refresh failed: ${err.message || err}`);
  } finally {
    refreshInProgress = false;
  }
}

if (AUTO_REFRESH_SECONDS > 0) {
  refreshData();
  setInterval(refreshData, AUTO_REFRESH_SECONDS * 1000);
}
