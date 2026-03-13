// Cloudflare Worker — browser-facing adapter for TzevaAdom APIs.
// This worker keeps the existing frontend contract:
//   { ok, generatedAt, lastPollAt, error, live, history, api }
// so public/app.js can remain stable without the OCI backend.
//
// Resilience rules:
//   1. Always respond 200 + CORS headers — never let a raw 502/503 reach the browser.
//   2. /oref/alerts: try tzevaadom first, fall back to direct oref.org.il on failure.
//   3. /oref/history: try tzevaadom; on failure return empty array (graceful degradation).
//   4. Outer try/catch on entire handler so no uncaught exception leaks without CORS headers.

const TZEVAADOM_NOTIFICATIONS_URL = "https://api.tzevaadom.co.il/notifications?";
const TZEVAADOM_HISTORY_URL       = "https://api.tzevaadom.co.il/alerts-history/?";
const LIVE_MAX_AGE_SECONDS        = 180;

const OREF_ALERTS_URL  = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const OREF_HEADERS = {
  "Pragma": "no-cache",
  "Cache-Control": "max-age=0",
  "Referer": "https://www.oref.org.il/12481-he/Pakar.aspx",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36",
};

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

// Always-safe 200 JSON response — CORS headers always present
function jsonOk(body, isHead = false) {
  if (isHead) return new Response(null, { status: 200, headers: CORS_HEADERS });
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status: 200, headers: CORS_HEADERS });
}

function buildErrorPayload(nowIso, message) {
  return {
    ok: false,
    generatedAt: nowIso,
    lastPollAt: null,
    error: message,
    live: [],
    history: [],
    api: { source: "none", error: message },
  };
}

// ── Type helpers ──────────────────────────────────────────────────────────────

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
  if (isDrill && !baseType.endsWith("Drill")) return toDrillType(baseType);
  return baseType;
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Data normalizers ──────────────────────────────────────────────────────────

function normalizeLiveAlerts(items, nowUnix) {
  if (!Array.isArray(items)) return [];
  const buckets = new Map();

  for (const item of items) {
    if (!item || !Array.isArray(item.cities) || item.cities.length === 0) continue;
    const threat     = parseIntOr(item.threat, 8);
    const isDrill    = Boolean(item.isDrill);
    const eventUnix  = parseIntOr(item.time, nowUnix);
    if (nowUnix - eventUnix > LIVE_MAX_AGE_SECONDS) continue;

    const type         = normalizeThreatType(threat, isDrill);
    const instructions = THREAT_TITLE_HE[threat] || "התרעה";
    const key          = `${type}|${instructions}|${threat}|${isDrill ? 1 : 0}`;

    if (!buckets.has(key)) {
      buckets.set(key, { id: `tzad-${eventUnix}-${type}`, type, instructions, cities: [], _latestUnix: eventUnix });
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

  return [...buckets.values()]
    .map(({ _latestUnix: _, ...rest }) => rest)
    .filter((a) => a.cities.length > 0);
}

function normalizeHistory(historyFeed, nowUnix) {
  if (!Array.isArray(historyFeed)) return [];
  const flat = [];

  for (const group of historyFeed) {
    if (!group || !Array.isArray(group.alerts)) continue;
    for (const alert of group.alerts) {
      if (!alert || !Array.isArray(alert.cities) || alert.cities.length === 0) continue;
      const eventUnix    = parseIntOr(alert.time, nowUnix);
      const threat       = parseIntOr(alert.threat, 8);
      const isDrill      = Boolean(alert.isDrill);
      const type         = normalizeThreatType(threat, isDrill);
      const instructions = THREAT_TITLE_HE[threat] || "התרעה";
      flat.push({
        timestamp: new Date(eventUnix * 1000).toISOString(),
        id: group.id != null ? String(group.id) : `tzad-h-${eventUnix}`,
        type,
        instructions,
        cities: alert.cities.map((c) => String(c || "").trim()).filter((c) => c && !c.includes("בדיקה")),
      });
    }
  }

  flat.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return flat;
}

// ── Upstream fetchers with fallback ──────────────────────────────────────────

// Try tzevaadom first; fall back to direct oref.org.il raw buffer on any failure.
// Returns { alerts[], source } or { rawBuffer, source } when oref fallback is used.
async function fetchLiveAlerts(nowUnix) {
  // Primary: tzevaadom
  try {
    const res = await fetch(TZEVAADOM_NOTIFICATIONS_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (res.ok) {
      const data = await res.json();
      return { alerts: normalizeLiveAlerts(Array.isArray(data) ? data : [], nowUnix), source: "tzevaadom" };
    }
  } catch (_) { /* fall through to oref */ }

  // Fallback: direct oref.org.il — return raw buffer (browser handles UTF-16-LE)
  try {
    const ts  = Math.round(Date.now() / 1000);
    const res = await fetch(`${OREF_ALERTS_URL}?${ts}`, {
      headers: OREF_HEADERS,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (res.ok) {
      return { rawBuffer: await res.arrayBuffer(), source: "oref-direct" };
    }
  } catch (_) { /* both failed */ }

  return { alerts: [], source: "none" };
}

// Try tzevaadom; on any failure return empty array (graceful degradation).
async function fetchHistoryAlerts(nowUnix) {
  try {
    const res = await fetch(TZEVAADOM_HISTORY_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
    if (res.ok) {
      const data = await res.json();
      return normalizeHistory(Array.isArray(data) ? data : [], nowUnix);
    }
  } catch (_) { /* degraded gracefully */ }
  return [];
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleOrefAlerts(request, nowUnix) {
  const isHead = request.method === "HEAD";
  const result = await fetchLiveAlerts(nowUnix);

  // Raw oref buffer fallback — pass straight through
  if (result.rawBuffer !== undefined) {
    if (isHead) return new Response(null, { status: 200, headers: CORS_HEADERS });
    return new Response(result.rawBuffer, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
      },
    });
  }

  const live = result.alerts || [];
  const CAT_BY_TYPE = {
    missiles: 1, general: 2, earthQuake: 3, radiologicalEvent: 4,
    tsunami: 5, hostileAircraftIntrusion: 6, hazardousMaterials: 7,
    newsFlash: 10, terroristInfiltration: 13,
    missilesDrill: 101, generalDrill: 102, earthQuakeDrill: 103,
    radiologicalEventDrill: 104, tsunamiDrill: 105,
    hostileAircraftIntrusionDrill: 106, hazardousMaterialsDrill: 107,
    terroristInfiltrationDrill: 113,
  };

  if (live.length === 0) return jsonOk("", isHead); // empty = no active alert

  const first     = live[0];
  const allCities = live.flatMap((a) => a.cities);
  const payload   = {
    id:    first.id || String(nowUnix),
    cat:   String(CAT_BY_TYPE[first.type] || 1),
    title: first.instructions || "",
    data:  [...new Set(allCities)],
  };
  return jsonOk(payload, isHead);
}

async function handleOrefHistory(request, nowUnix) {
  const isHead = request.method === "HEAD";
  const normalized = await fetchHistoryAlerts(nowUnix);

  const TYPE_TO_HIST_CAT = {
    missiles: 1, hostileAircraftIntrusion: 2, general: 3,
    earthQuake: 7, radiologicalEvent: 9, terroristInfiltration: 10,
    tsunami: 11, hazardousMaterials: 12, newsFlash: 13,
    missilesDrill: 15, hostileAircraftIntrusionDrill: 16,
    generalDrill: 17, earthQuakeDrill: 21, radiologicalEventDrill: 23,
    terroristInfiltrationDrill: 24, tsunamiDrill: 25, hazardousMaterialsDrill: 26,
  };

  const orefHistory = normalized.flatMap((item) =>
    item.cities.map((city) => ({
      alertDate: item.timestamp
        ? new Date(item.timestamp).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" })
        : new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }),
      data:     city,
      category: String(TYPE_TO_HIST_CAT[item.type] || 1),
      title:    item.instructions || "",
      id:       item.id || null,
    }))
  );

  return jsonOk(orefHistory, isHead);
}

async function handleMain(request, nowUnix, nowIso) {
  const isHead = request.method === "HEAD";

  const [liveResult, histResult] = await Promise.allSettled([
    fetchLiveAlerts(nowUnix),
    fetchHistoryAlerts(nowUnix),
  ]);

  const liveData = liveResult.status === "fulfilled" ? liveResult.value : { alerts: [], source: "none" };
  const history  = histResult.status  === "fulfilled" ? histResult.value  : [];
  const live     = liveData.alerts || [];

  return jsonOk({
    ok: true,
    generatedAt: nowIso,
    lastPollAt:  nowIso,
    error: null,
    live,
    history,
    api: { source: liveData.source || "tzevaadom", notificationsCount: live.length, usedHistoryFallback: false },
  }, isHead);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(request) {
    // Top-level safety net — always return 200 + CORS no matter what
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
      }

      const pathname = new URL(request.url).pathname;
      const nowUnix  = Math.floor(Date.now() / 1000);
      const nowIso   = new Date().toISOString();

      if (pathname === "/oref/alerts")  return await handleOrefAlerts(request, nowUnix);
      if (pathname === "/oref/history") return await handleOrefHistory(request, nowUnix);
      return await handleMain(request, nowUnix, nowIso);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[worker] unhandled error:", msg);
      const isHead = request.method === "HEAD";
      return jsonOk(buildErrorPayload(new Date().toISOString(), msg), isHead);
    }
  },
};
