const fs = require("fs");
const path = require("path");
const pikudHaoref = require("pikud-haoref-api");

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "public", "data");
const RAW_ALERTS_PATH = path.join(DATA_DIR, "raw-alerts.json");
const LOOKUP_PATH = path.join(DATA_DIR, "zones-lookup.json");
const CITIES_ARCHIVE_PATH = path.join(
  PROJECT_ROOT,
  "node_modules",
  "pikud-haoref-api",
  "cities.json"
);

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\u200f|\u200e/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function buildLookup(citiesArchive) {
  const entries = [];
  const seen = new Set();

  for (const city of citiesArchive || []) {
    if (!city || !city.name) continue;
    if (city.name === "בחר הכל") continue;
    if (!city.lat || !city.lng) continue;

    const normalizedName = normalizeName(city.name);
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);

    entries.push({
      name: city.name,
      normalizedName,
      lat: city.lat,
      lng: city.lng,
      zone: city.zone || null,
      countdown: city.countdown || null,
    });
  }

  return entries;
}

function logGroupedApiMessages(alerts) {
  const now = nowIso();
  if (!Array.isArray(alerts) || alerts.length === 0) {
    console.log(`[API ${now}] אין התראות פעילות`);
    return;
  }

  const grouped = {};
  for (const alert of alerts) {
    const type = alert && alert.type ? alert.type : "unknown";
    const instructions = alert && alert.instructions ? alert.instructions : "";
    const key = `${type}|${normalizeName(instructions)}`;
    if (!grouped[key]) {
      grouped[key] = { type, instructions: instructions || null, cities: [] };
    }
    const cities = Array.isArray(alert && alert.cities) ? alert.cities : [];
    for (const city of cities) {
      const clean = normalizeName(city);
      if (clean && grouped[key].cities.indexOf(clean) === -1) {
        grouped[key].cities.push(clean);
      }
    }
  }

  const summary = Object.values(grouped).map((g) => ({
    type: g.type,
    instructions: g.instructions,
    citiesCount: g.cities.length,
    cities: g.cities,
  }));

  console.log(`[API ${now}] הודעות שהתקבלו:`);
  console.log(JSON.stringify(summary, null, 2));
}

function fetchActiveAlerts(options = {}) {
  return new Promise((resolve, reject) => {
    pikudHaoref.getActiveAlerts((err, alerts) => {
      if (err) return reject(err);
      if (!Array.isArray(alerts)) return resolve([]);
      resolve(alerts);
    }, options);
  });
}

async function buildStaticData() {
  ensureDataDir();

  const citiesArchive = (() => {
    try {
      return JSON.parse(fs.readFileSync(CITIES_ARCHIVE_PATH, "utf8"));
    } catch (_err) {
      return [];
    }
  })();

  const lookupEntries = buildLookup(citiesArchive);
  writeJson(LOOKUP_PATH, {
    generatedAt: nowIso(),
    count: lookupEntries.length,
    cities: lookupEntries,
  });

  const requestOptions = { timeout: 10000 };
  if (process.env.PIKUD_PROXY_URL) {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    requestOptions.httpsAgent = new HttpsProxyAgent(process.env.PIKUD_PROXY_URL);
  }

  let activeAlerts = [];
  let apiError = null;
  try {
    activeAlerts = await fetchActiveAlerts(requestOptions);
  } catch (err) {
    apiError = err.message || String(err);
  }

  if (!apiError) {
    logGroupedApiMessages(activeAlerts);
  }

  writeJson(RAW_ALERTS_PATH, {
    generatedAt: nowIso(),
    api: {
      source: "pikud-haoref-api.getActiveAlerts",
      error: apiError,
    },
    alerts: activeAlerts,
  });

  console.log(`Wrote ${LOOKUP_PATH}`);
  console.log(`Wrote ${RAW_ALERTS_PATH}`);
  if (apiError) {
    console.warn(`Alert fetch error: ${apiError}`);
  } else {
    console.log(`Fetched ${activeAlerts.length} active alert object(s).`);
  }
}

module.exports = { buildStaticData };

if (require.main === module) {
  buildStaticData().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
