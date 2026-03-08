const ALERTS_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const HISTORY_URL = "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json";

const OREF_HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "max-age=0",
  Referer: "https://www.oref.org.il/11226-he/pakar.aspx",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/75.0.3770.100 Safari/537.36",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

// Category → alert type mappings (mirrored from pikud-haoref-api)
const CATEGORY_MAP = {
  1: "missiles", 2: "general", 3: "earthQuake", 4: "radiologicalEvent",
  5: "tsunami", 6: "hostileAircraftIntrusion", 7: "hazardousMaterials",
  10: "newsFlash", 13: "terroristInfiltration",
  101: "missilesDrill", 102: "generalDrill", 103: "earthQuakeDrill",
  104: "radiologicalEventDrill", 105: "tsunamiDrill",
  106: "hostileAircraftIntrusionDrill", 107: "hazardousMaterialsDrill",
  113: "terroristInfiltrationDrill",
};

const HISTORY_CATEGORY_MAP = {
  1: "missiles", 2: "hostileAircraftIntrusion", 3: "general", 4: "general",
  5: "general", 6: "general", 7: "earthQuake", 8: "earthQuake",
  9: "radiologicalEvent", 10: "terroristInfiltration", 11: "tsunami",
  12: "hazardousMaterials", 13: "newsFlash", 14: "newsFlash",
  15: "missilesDrill", 16: "hostileAircraftIntrusionDrill",
  17: "generalDrill", 18: "generalDrill", 19: "generalDrill", 20: "generalDrill",
  21: "earthQuakeDrill", 22: "earthQuakeDrill", 23: "radiologicalEventDrill",
  24: "terroristInfiltrationDrill", 25: "tsunamiDrill", 26: "hazardousMaterialsDrill",
};

function parseAlertJson(json) {
  if (!json.data) return [];
  const alert = {
    type: CATEGORY_MAP[parseInt(json.cat)] || "missiles",
    cities: [],
    instructions: json.title || null,
    id: json.id || null,
  };
  for (const city of json.data) {
    const c = (city || "").trim();
    if (c && c.indexOf("בדיקה") === -1 && !alert.cities.includes(c)) {
      alert.cities.push(c);
    }
  }
  return alert.cities.length > 0 ? [alert] : [];
}

function parseHistoryJson(json) {
  if (!Array.isArray(json) || json.length === 0) return [];
  const now = Date.now() / 1000;
  const buckets = {};
  for (const item of json) {
    if (!item.alertDate || !item.data || !item.category) continue;
    const unix = new Date(item.alertDate).getTime() / 1000;
    if (now - unix > 120) continue;
    const city = (item.data || "").trim();
    if (!city || city.indexOf("בדיקה") !== -1) continue;
    const cat = parseInt(item.category);
    if (!buckets[cat]) {
      buckets[cat] = {
        type: HISTORY_CATEGORY_MAP[cat] || "unknown",
        cities: [],
        instructions: item.title || null,
      };
    }
    if (!buckets[cat].cities.includes(city)) buckets[cat].cities.push(city);
  }
  return Object.values(buckets).filter((a) => a.cities.length > 0);
}

async function fetchAlerts() {
  // Try primary Alerts.json first
  const ts = Math.round(Date.now() / 1000);
  const res = await fetch(`${ALERTS_URL}?${ts}`, { headers: OREF_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  let body = new TextDecoder("utf-8").decode(buf).replace(/\x00/g, "").trim();

  // Strip BOM if present
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

  let alerts = [];
  if (body !== "") {
    const json = JSON.parse(body);
    alerts = parseAlertJson(json);
  }

  // Fall back to AlertsHistory.json when primary is empty
  if (alerts.length === 0) {
    const hres = await fetch(`${HISTORY_URL}?${ts}`, { headers: OREF_HEADERS });
    if (hres.ok) {
      const hbuf = await hres.arrayBuffer();
      let hbody = new TextDecoder("utf-8").decode(hbuf).replace(/\x00/g, "").trim();
      if (hbody.charCodeAt(0) === 0xfeff) hbody = hbody.slice(1);
      if (hbody !== "") {
        alerts = parseHistoryJson(JSON.parse(hbody));
      }
    }
  }

  return alerts;
}

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const alerts = await fetchAlerts();
      const body = JSON.stringify({
        generatedAt: new Date().toISOString(),
        api: { source: "oref.org.il", error: null },
        alerts,
      });
      return new Response(body, {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      const body = JSON.stringify({
        generatedAt: new Date().toISOString(),
        api: { source: "oref.org.il", error: err.message },
        alerts: [],
      });
      return new Response(body, {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
      });
    }
  },
};
