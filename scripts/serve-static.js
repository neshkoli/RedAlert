const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildStaticData } = require("./build-static-data");

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
