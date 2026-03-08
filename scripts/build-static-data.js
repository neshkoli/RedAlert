const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "public", "data");
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

  console.log(`Wrote ${LOOKUP_PATH} (${lookupEntries.length} cities)`);
}

module.exports = { buildStaticData };

if (require.main === module) {
  buildStaticData().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
