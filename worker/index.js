// Cloudflare Worker — browser-facing adapter for TzevaAdom APIs.
// This worker keeps the existing frontend contract:
//   { ok, generatedAt, lastPollAt, error, live, history, api }
// so public/app.js can remain stable without the OCI backend.

const TZEVAADOM_NOTIFICATIONS_URL = "https://api.tzevaadom.co.il/notifications?";
const TZEVAADOM_HISTORY_URL = "https://api.tzevaadom.co.il/alerts-history/?";
const HISTORY_MAX_ITEMS = 200;
const LIVE_MAX_AGE_SECONDS = 180;
const HISTORY_MAX_AGE_SECONDS = 24 * 60 * 60;

const THREAT_TYPE_MAP = {
  0: "missiles",
  1: "hazardousMaterials",
  2: "terroristInfiltration",
  3: "earthQuake",
  4: "tsunami",
  5: "hostileAircraftIntrusion",
  6: "radiologicalEvent",
  7: "general",
  8: "general",
  9: "generalDrill",
};

const THREAT_TITLE_HE = {
  0: "צבע אדום",
  1: "אירוע חומרים מסוכנים",
  2: "חשש לחדירת מחבלים",
  3: "רעידת אדמה",
  4: "חשש לצונאמי",
  5: "חדירת כלי טיס עוין",
  6: "חשש לאירוע רדיולוגי",
  7: "ירי בלתי קונבנציונלי",
  8: "התרעה",
  9: "תרגיל פיקוד העורף",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

function toDrillType(baseType) {
  const drillMap = {
    missiles: "missilesDrill",
    general: "generalDrill",
    earthQuake: "earthQuakeDrill",
    radiologicalEvent: "radiologicalEventDrill",
    tsunami: "tsunamiDrill",
    hostileAircraftIntrusion: "hostileAircraftIntrusionDrill",
    hazardousMaterials: "hazardousMaterialsDrill",
    terroristInfiltration: "terroristInfiltrationDrill",
  };
  return drillMap[baseType] || "generalDrill";
}

function normalizeThreatType(threat, isDrill) {
  const baseType = THREAT_TYPE_MAP[threat] || "general";
  if (isDrill && !baseType.endsWith("Drill")) {
    return toDrillType(baseType);
  }
  return baseType;
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLiveAlerts(items, nowUnix) {
  if (!Array.isArray(items)) return [];
  const buckets = new Map();

  for (const item of items) {
    if (!item || !Array.isArray(item.cities) || item.cities.length === 0) continue;
    const threat = parseIntOr(item.threat, 8);
    const isDrill = Boolean(item.isDrill);
    const eventUnix = parseIntOr(item.time, nowUnix);
    if (nowUnix - eventUnix > LIVE_MAX_AGE_SECONDS) continue;

    const type = normalizeThreatType(threat, isDrill);
    const instructions = THREAT_TITLE_HE[threat] || "התרעה";
    const key = `${type}|${instructions}|${threat}|${isDrill ? 1 : 0}`;

    if (!buckets.has(key)) {
      buckets.set(key, {
        id: `tzad-${eventUnix}-${type}`,
        type,
        instructions,
        cities: [],
        _latestUnix: eventUnix,
      });
    }

    const bucket = buckets.get(key);
    if (eventUnix > bucket._latestUnix) {
      bucket._latestUnix = eventUnix;
      bucket.id = `tzad-${eventUnix}-${type}`;
    }

    for (const rawCity of item.cities) {
      const city = String(rawCity || "").trim();
      if (!city || city.includes("בדיקה")) continue;
      if (!bucket.cities.includes(city)) bucket.cities.push(city);
    }
  }

  const out = [];
  for (const value of buckets.values()) {
    delete value._latestUnix;
    if (value.cities.length > 0) out.push(value);
  }
  return out;
}

function normalizeHistory(historyFeed, nowUnix) {
  if (!Array.isArray(historyFeed)) return [];
  const flat = [];

  for (const group of historyFeed) {
    if (!group || !Array.isArray(group.alerts)) continue;
    for (const alert of group.alerts) {
      if (!alert || !Array.isArray(alert.cities) || alert.cities.length === 0) continue;
      const eventUnix = parseIntOr(alert.time, nowUnix);
      if (nowUnix - eventUnix > HISTORY_MAX_AGE_SECONDS) continue;
      const threat = parseIntOr(alert.threat, 8);
      const isDrill = Boolean(alert.isDrill);
      const type = normalizeThreatType(threat, isDrill);
      const instructions = THREAT_TITLE_HE[threat] || "התרעה";
      flat.push({
        timestamp: new Date(eventUnix * 1000).toISOString(),
        id: group.id != null ? String(group.id) : `tzad-h-${eventUnix}`,
        type,
        instructions,
        cities: alert.cities
          .map((c) => String(c || "").trim())
          .filter((c) => c && !c.includes("בדיקה")),
      });
    }
  }

  flat.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return flat.slice(0, HISTORY_MAX_ITEMS);
}

async function fetchJson(url) {
  const response = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

function buildErrorPayload(nowIso, message) {
  return {
    ok: false,
    generatedAt: nowIso,
    lastPollAt: null,
    error: message,
    live: [],
    history: [],
    api: { source: "tzevaadom", error: message },
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    const nowIso = new Date().toISOString();
    const nowUnix = Math.floor(Date.now() / 1000);

    try {
      // Primary source for active alerts
      let notifications = [];
      let notificationsError = null;
      try {
        notifications = await fetchJson(TZEVAADOM_NOTIFICATIONS_URL);
      } catch (err) {
        notificationsError = err instanceof Error ? err.message : "notifications fetch failed";
      }
      const live = normalizeLiveAlerts(notifications, nowUnix);

      // History source and fallback path
      let historyFeed = [];
      if (live.length === 0 || notificationsError) {
        historyFeed = await fetchJson(TZEVAADOM_HISTORY_URL);
      }
      const history = normalizeHistory(historyFeed, nowUnix);

      const payload = {
        ok: true,
        generatedAt: nowIso,
        lastPollAt: nowIso,
        error: null,
        live,
        history,
        api: {
          source: "tzevaadom",
          error: notificationsError,
          notificationsCount: Array.isArray(notifications) ? notifications.length : 0,
          usedHistoryFallback: live.length === 0 || Boolean(notificationsError),
        },
      };

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upstream fetch failed";
      const errorPayload = buildErrorPayload(nowIso, message);

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: CORS_HEADERS });
      }

      return new Response(
        JSON.stringify(errorPayload),
        { status: 200, headers: CORS_HEADERS }
      );
    }
  },
};
