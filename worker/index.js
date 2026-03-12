// Cloudflare Worker — browser-facing adapter for TzevaAdom APIs.
// This worker keeps the existing frontend contract:
//   { ok, generatedAt, lastPollAt, error, live, history, api }
// so public/app.js can remain stable without the OCI backend.

const TZEVAADOM_NOTIFICATIONS_URL = "https://api.tzevaadom.co.il/notifications?";
const TZEVAADOM_HISTORY_URL = "https://api.tzevaadom.co.il/alerts-history/?";
const LIVE_MAX_AGE_SECONDS = 180;

const OREF_ALERTS_URL  = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const OREF_HISTORY_URL = "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";
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
  return flat;
}

async function fetchJson(url) {
  const response = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}

async function fetchOrefRaw(url) {
  const ts = Math.round(Date.now() / 1000);
  const response = await fetch(`${url}?${ts}`, {
    headers: OREF_HEADERS,
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  // Return raw buffer so the browser-side JS can decode (UTF-16-LE etc.)
  const buffer = await response.arrayBuffer();
  return buffer;
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

    const url = new URL(request.url);

    // /oref/alerts — synthesize oref Alerts.json format from tzevaadom live data
    // (oref.org.il blocks Cloudflare IPs; tzevaadom is the reliable upstream)
    if (url.pathname === "/oref/alerts") {
      try {
        const ts = Math.round(Date.now() / 1000);
        const res = await fetch(TZEVAADOM_NOTIFICATIONS_URL, {
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const notifications = res.ok ? await res.json() : [];
        const live = normalizeLiveAlerts(Array.isArray(notifications) ? notifications : [], ts);

        // Synthesize oref Alerts.json shape: { id, cat, title, data: [city,...] }
        // Use first live alert if present, else empty
        let orefPayload;
        if (live.length > 0) {
          const first = live[0];
          const CAT_BY_TYPE = {
            missiles: 1, general: 2, earthQuake: 3, radiologicalEvent: 4,
            tsunami: 5, hostileAircraftIntrusion: 6, hazardousMaterials: 7,
            newsFlash: 10, terroristInfiltration: 13,
            missilesDrill: 101, generalDrill: 102, earthQuakeDrill: 103,
            radiologicalEventDrill: 104, tsunamiDrill: 105,
            hostileAircraftIntrusionDrill: 106, hazardousMaterialsDrill: 107,
            terroristInfiltrationDrill: 113,
          };
          const allCities = live.flatMap((a) => a.cities);
          orefPayload = {
            id: first.id || String(ts),
            cat: String(CAT_BY_TYPE[first.type] || 1),
            title: first.instructions || "",
            data: [...new Set(allCities)],
          };
        } else {
          orefPayload = "";  // empty string = no active alert (oref convention)
        }

        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: CORS_HEADERS });
        }
        return new Response(
          typeof orefPayload === "string" ? orefPayload : JSON.stringify(orefPayload),
          { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: CORS_HEADERS });
      }
    }

    // /oref/history — synthesize oref AlertsHistory.json format from tzevaadom history
    if (url.pathname === "/oref/history") {
      try {
        const res = await fetch(TZEVAADOM_HISTORY_URL, {
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const historyFeed = res.ok ? await res.json() : [];
        const nowUnix = Math.floor(Date.now() / 1000);
        const normalized = normalizeHistory(Array.isArray(historyFeed) ? historyFeed : [], nowUnix);

        // Synthesize oref AlertsHistory.json shape: [{alertDate, data, category, title, id}]
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
            data: city,
            category: String(TYPE_TO_HIST_CAT[item.type] || 1),
            title: item.instructions || "",
            id: item.id || null,
          }))
        );

        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: CORS_HEADERS });
        }
        return new Response(JSON.stringify(orefHistory), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: CORS_HEADERS });
      }
    }

    const nowIso = new Date().toISOString();
    const nowUnix = Math.floor(Date.now() / 1000);

    try {
      // Fetch notifications and history in parallel
      let notifications = [];
      let notificationsError = null;
      let historyFeed = [];
      let historyError = null;

      const [notifResult, histResult] = await Promise.allSettled([
        fetchJson(TZEVAADOM_NOTIFICATIONS_URL),
        fetchJson(TZEVAADOM_HISTORY_URL),
      ]);

      if (notifResult.status === "fulfilled") {
        notifications = notifResult.value;
      } else {
        notificationsError = notifResult.reason instanceof Error
          ? notifResult.reason.message
          : "notifications fetch failed";
      }

      if (histResult.status === "fulfilled") {
        historyFeed = histResult.value;
      } else {
        historyError = histResult.reason instanceof Error
          ? histResult.reason.message
          : "history fetch failed";
      }

      const live = normalizeLiveAlerts(notifications, nowUnix);
      const history = normalizeHistory(historyFeed, nowUnix);

      const payload = {
        ok: true,
        generatedAt: nowIso,
        lastPollAt: nowIso,
        error: notificationsError || historyError || null,
        live,
        history,
        api: {
          source: "tzevaadom",
          error: notificationsError,
          historyError,
          notificationsCount: Array.isArray(notifications) ? notifications.length : 0,
          usedHistoryFallback: false,
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
