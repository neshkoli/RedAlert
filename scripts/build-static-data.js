const fs = require("fs");
const path = require("path");
const pikudHaoref = require("pikud-haoref-api");

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "public", "data");
const ALERTS_PATH = path.join(DATA_DIR, "active-alerts.json");
const LOOKUP_PATH = path.join(DATA_DIR, "zones-lookup.json");
const CITIES_ARCHIVE_PATH = path.join(
  PROJECT_ROOT,
  "node_modules",
  "pikud-haoref-api",
  "cities.json"
);

const ENDED_TTL_MS = 60 * 1000;
const STALE_ALERT_MS = 15 * 60 * 1000;
const MAX_HISTORY_ITEMS = 1000;

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

function safeReadJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) return fallbackValue;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed reading JSON ${filePath}: ${err.message}`);
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function getHistorySignature(item) {
  return [
    normalizeName(item.name),
    item.state || "unknown",
    item.alertType || "unknown",
    normalizeName(item.instructions || ""),
  ].join("|");
}

function isNewsFlashType(type) {
  return type === "newsFlash" || type === "earlyWarning";
}

function typePriority(type) {
  // If same city appears in multiple active alerts:
  // keep the "more urgent" type for map coloring.
  return isNewsFlashType(type) ? 1 : 2;
}

function isEndedInstruction(instructions) {
  return normalizeName(instructions) === "האירוע הסתיים";
}

function zonePriority(candidate) {
  // If city appears both as active and ended in same poll,
  // keep active signal over ended signal.
  const stateBias = candidate.state === "ended" ? -100 : 0;
  return typePriority(candidate.alertType) + stateBias;
}

function pickCurrentZones(alerts) {
  const byName = {};

  for (const alert of alerts || []) {
    const alertType = alert && alert.type ? alert.type : "unknown";
    const instructions = alert && alert.instructions ? alert.instructions : null;
    const isEnded = isEndedInstruction(instructions);
    const cities = Array.isArray(alert && alert.cities) ? alert.cities : [];

    for (const city of cities) {
      const key = normalizeName(city);
      if (!key) continue;

      const candidate = {
        name: city,
        normalizedName: key,
        alertType,
        state: isEnded ? "ended" : "active",
        alertId: alert.id || null,
        instructions,
      };

      const existing = byName[key];
      if (!existing || zonePriority(candidate) > zonePriority(existing)) {
        byName[key] = candidate;
      }
    }
  }

  return byName;
}

function buildLookup(citiesArchive) {
  const entries = [];
  const byName = {};

  for (const city of citiesArchive || []) {
    if (!city || !city.name) continue;
    if (city.name === "בחר הכל") continue;
    if (!city.lat || !city.lng) continue;

    const normalizedName = normalizeName(city.name);
    if (!normalizedName) continue;

    const entry = {
      name: city.name,
      normalizedName,
      lat: city.lat,
      lng: city.lng,
      zone: city.zone || null,
      countdown: city.countdown || null,
    };

    entries.push(entry);
    if (!byName[normalizedName]) {
      byName[normalizedName] = entry;
    }
  }

  return { entries, byName };
}

function mergeZoneStates(currentByName, previousZones, previousHistory, lookupByName) {
  const merged = [];
  const seen = new Set();
  const newHistory = [];
  const now = Date.now();
  const nowISO = new Date(now).toISOString();

  const previousByName = {};
  for (const z of previousZones || []) {
    if (!z || !z.normalizedName) continue;
    previousByName[z.normalizedName] = z;
  }

  function hasRecentHistoryEvent(zone, eventState, lookbackMs) {
    const history = previousHistory || [];
    const nowMs = now;
    const targetName = normalizeName(zone.name);
    const targetType = zone.alertType || "unknown";
    const targetInstructions = normalizeName(zone.instructions);

    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (!item) continue;
      const itemTs = new Date(item.timestamp || 0).getTime();
      if (!itemTs || nowMs - itemTs > lookbackMs) {
        break;
      }

      if (
        normalizeName(item.name) === targetName &&
        item.state === eventState &&
        (item.alertType || "unknown") === targetType &&
        normalizeName(item.instructions) === targetInstructions
      ) {
        return true;
      }
    }

    return false;
  }

  function pushHistoryEvent(zone, eventState, reason) {
    newHistory.push({
      timestamp: nowISO,
      name: zone.name,
      normalizedName: zone.normalizedName,
      alertType: zone.alertType || "unknown",
      state: eventState,
      instructions: zone.instructions || null,
      reason: reason || null,
      lat: zone.lat != null ? zone.lat : null,
      lng: zone.lng != null ? zone.lng : null,
    });
  }

  for (const key of Object.keys(currentByName)) {
    const current = currentByName[key];
    const prev = previousByName[key];
    const lookup = lookupByName[key] || null;
    const currentIsEnded = current.state === "ended";
    seen.add(key);

    if (currentIsEnded) {
      // Ended instruction explicitly clears current active marker immediately.
      if (!prev || prev.state !== "ended") {
        const historyZone = {
          ...current,
          lat: lookup ? lookup.lat : prev && prev.lat != null ? prev.lat : null,
          lng: lookup ? lookup.lng : prev && prev.lng != null ? prev.lng : null,
        };
        const duplicateEnded = hasRecentHistoryEvent(historyZone, "ended", 30 * 60 * 1000);
        if (!duplicateEnded) {
          pushHistoryEvent(historyZone, "ended", "ended_instruction");
        }
      }
      continue;
    }

    const prevState = prev ? prev.state : null;
    const prevType = prev ? prev.alertType : null;
    const prevInstructions = prev ? normalizeName(prev.instructions) : "";
    const currInstructions = normalizeName(current.instructions);
    const isNewEvent =
      !prev ||
      prevState !== "active" ||
      prevType !== current.alertType ||
      prevInstructions !== currInstructions;

    const zone = {
      ...current,
      state: "active",
      startedAt: prev && prev.state === "active" && prev.startedAt ? prev.startedAt : nowISO,
      endedAt: null,
      lastSeenAt: nowISO,
      lat: lookup ? lookup.lat : prev && prev.lat != null ? prev.lat : null,
      lng: lookup ? lookup.lng : prev && prev.lng != null ? prev.lng : null,
      zone: lookup ? lookup.zone : prev && prev.zone ? prev.zone : null,
    };

    merged.push(zone);
    if (isNewEvent) {
      pushHistoryEvent(zone, "active", "new_or_changed");
    }
  }

  for (const key of Object.keys(previousByName)) {
    if (seen.has(key)) continue;
    const prev = previousByName[key];

    if (prev.state !== "active") {
      continue;
    }

    const lastSeenAtMs = new Date(prev.lastSeenAt || prev.startedAt || 0).getTime();
    if (lastSeenAtMs > 0 && now - lastSeenAtMs <= STALE_ALERT_MS) {
      // Keep displaying previous alert until explicit end event or 15 minutes timeout.
      merged.push(prev);
      continue;
    }

    pushHistoryEvent(prev, "expired", "stale_timeout_15m");
  }

  return {
    zones: merged,
    history: upsertHistoryEvents(previousHistory || [], newHistory),
  };
}

function upsertHistoryEvents(previousHistory, incomingEvents) {
  const bySignature = new Map();

  for (const item of previousHistory || []) {
    if (!item) continue;
    bySignature.set(getHistorySignature(item), { ...item });
  }

  for (const item of incomingEvents || []) {
    if (!item) continue;
    const key = getHistorySignature(item);
    const existing = bySignature.get(key);

    if (!existing) {
      bySignature.set(key, { ...item });
      continue;
    }

    // Keep one row per identical message, with latest timestamp.
    const existingTs = new Date(existing.timestamp || 0).getTime();
    const incomingTs = new Date(item.timestamp || 0).getTime();
    if (incomingTs >= existingTs) {
      bySignature.set(key, {
        ...existing,
        ...item,
        timestamp: item.timestamp,
      });
    }
  }

  const sorted = Array.from(bySignature.values()).sort((a, b) => {
    const left = new Date(a.timestamp || 0).getTime();
    const right = new Date(b.timestamp || 0).getTime();
    return right - left;
  });

  return sorted.slice(0, MAX_HISTORY_ITEMS);
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
      grouped[key] = {
        type,
        instructions: instructions || null,
        cities: [],
      };
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

  const citiesArchive = safeReadJson(CITIES_ARCHIVE_PATH, []);
  const { entries: lookupEntries, byName: lookupByName } = buildLookup(citiesArchive);
  writeJson(LOOKUP_PATH, {
    generatedAt: nowIso(),
    count: lookupEntries.length,
    cities: lookupEntries,
  });

  const previousAlerts = safeReadJson(ALERTS_PATH, { zones: [], history: [] });

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

  const currentByName = pickCurrentZones(activeAlerts);
  const mergedResult = mergeZoneStates(
    currentByName,
    previousAlerts.zones || [],
    previousAlerts.history || [],
    lookupByName
  );
  const unresolvedZones = mergedResult.zones
    .filter((z) => z.state === "active" && (z.lat == null || z.lng == null))
    .map((z) => z.name);

  const payload = {
    generatedAt: nowIso(),
    endedTtlMs: ENDED_TTL_MS,
    api: {
      source: "pikud-haoref-api.getActiveAlerts",
      error: apiError,
    },
    alerts: activeAlerts,
    zones: mergedResult.zones,
    history: mergedResult.history,
    unresolvedZones,
    staleAlertMs: STALE_ALERT_MS,
  };

  writeJson(ALERTS_PATH, payload);
  console.log(`Wrote ${LOOKUP_PATH}`);
  console.log(`Wrote ${ALERTS_PATH}`);
  if (apiError) {
    console.warn(`Alert fetch error: ${apiError}`);
  } else {
    console.log(`Fetched ${activeAlerts.length} active alert object(s).`);
  }
}

module.exports = {
  buildStaticData,
};

if (require.main === module) {
  buildStaticData().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
