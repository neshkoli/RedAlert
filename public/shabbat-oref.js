// shabbat-oref.js — Always-on Shabbat alert monitor
// Polls www.oref.org.il directly every 5 seconds.
//
// Local dev:  same-origin proxy routes in serve-static.js
//   GET /api/oref/alerts   → oref.org.il/Alerts.json
//   GET /api/oref/history  → oref.org.il/AlertsHistory.json
//
// Production (GitHub Pages): Cloudflare Worker at redalert-proxy.neshkoli.workers.dev
//   GET /oref/alerts   → proxies oref.org.il/Alerts.json
//   GET /oref/history  → proxies oref.org.il/AlertsHistory.json

const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";

const WORKER_BASE = "https://redalert-proxy.neshkoli.workers.dev";

const ALERTS_URL  = IS_LOCAL ? "/api/oref/alerts"  : WORKER_BASE + "/oref/alerts";
const HISTORY_URL = IS_LOCAL ? "/api/oref/history" : WORKER_BASE + "/oref/history";

const ZONES_URL         = "./data/zones-lookup.json";
const POLL_MS           = 5000;
const ENDED_TTL_MS      = 60 * 1000;
const HISTORY_MAX_AGE_S = 120;
const MAX_HISTORY       = 40;
const STORAGE_CITY      = "shabbat_city_v1";
const STORAGE_AUDIO     = "shabbat_audio_unlocked_v1";

// Alert types considered RED (immediate danger)
const RED_TYPES = new Set([
  "missiles", "terroristInfiltration", "hazardousMaterials",
  "hostileAircraftIntrusion", "radiologicalEvent", "tsunami", "earthQuake",
  "missilesDrill", "terroristInfiltrationDrill", "hazardousMaterialsDrill",
  "hostileAircraftIntrusionDrill", "radiologicalEventDrill",
  "tsunamiDrill", "earthQuakeDrill",
]);

// Category → type mapping (mirrors pikud-haoref-api/lib/alerts.js getAlertTypeByCategory)
function alertTypeByCategory(cat) {
  switch (parseInt(cat)) {
    case 1:   return "missiles";
    case 2:   return "general";
    case 3:   return "earthQuake";
    case 4:   return "radiologicalEvent";
    case 5:   return "tsunami";
    case 6:   return "hostileAircraftIntrusion";
    case 7:   return "hazardousMaterials";
    case 10:  return "newsFlash";
    case 13:  return "terroristInfiltration";
    case 101: return "missilesDrill";
    case 102: return "generalDrill";
    case 103: return "earthQuakeDrill";
    case 104: return "radiologicalEventDrill";
    case 105: return "tsunamiDrill";
    case 106: return "hostileAircraftIntrusionDrill";
    case 107: return "hazardousMaterialsDrill";
    case 113: return "terroristInfiltrationDrill";
    default:  return "general";
  }
}

// Historical category → type mapping (mirrors getAlertTypeByHistoricalCategory)
function alertTypeByHistCategory(cat) {
  switch (parseInt(cat)) {
    case 1:  return "missiles";
    case 2:  return "hostileAircraftIntrusion";
    case 3:  case 4:  case 5:  case 6:  return "general";
    case 7:  case 8:  return "earthQuake";
    case 9:  return "radiologicalEvent";
    case 10: return "terroristInfiltration";
    case 11: return "tsunami";
    case 12: return "hazardousMaterials";
    case 13: case 14: return "newsFlash";
    case 15: return "missilesDrill";
    case 16: return "hostileAircraftIntrusionDrill";
    case 17: case 18: case 19: case 20: return "generalDrill";
    case 21: case 22: return "earthQuakeDrill";
    case 23: return "radiologicalEventDrill";
    case 24: return "terroristInfiltrationDrill";
    case 25: return "tsunamiDrill";
    case 26: return "hazardousMaterialsDrill";
    default: return "general";
  }
}

// ===== State =====
const state = {
  city: "",
  status: "normal",
  endedTimer: null,
  history: [],
  shownHistoryIds: new Set(),
  audioCtx: null,
  audioUnlocked: false,
  wakeLock: null,
  _lastLive: [],         // last successfully parsed live alerts
};

// ===== DOM refs =====
const $ = (id) => document.getElementById(id);
const elClock        = $("clock");
const elStatusIcon   = $("status-icon");
const elStatusTitle  = $("status-title");
const elStatusSub    = $("status-subtitle");
const elStatusCities = $("status-cities");
const elHistoryList  = $("history-list");
const elCityInput    = $("city-input");
const elCityOptions  = $("city-options");
const elAudioBtn     = $("audio-unlock-btn");
const elConnStatus   = $("conn-status");
const elSetupBar     = $("setup-bar");
const elSetupBarCity = $("setup-bar-city");
const elSetupDrawer  = $("setup-drawer");
const elToggleIcon   = $("setup-toggle-icon");

// ===== Setup panel toggle =====
elSetupBar.addEventListener("click", () => {
  const open = elSetupDrawer.classList.toggle("open");
  elToggleIcon.textContent = open ? "▲" : "▼";
});

// ===== Threat SVG icons — from app.js getAlertTypeIconSvg =====
function getThreatSvg(type) {
  const base = (type || "").replace(/Drill$/, "");
  switch (base) {
    case "missiles":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(8,8) scale(1.9)"><path d="M25.744,6.604C26.08,6.267,26.107,6.02,25.48,6.02c-0.628,0-4.556,0-5.068,0c-0.512,0-0.533,0.016-0.814,0.297c-0.281,0.281-4.604,4.607-4.604,4.607s5.413,0,5.877,0c0.465,0,0.633-0.037,0.912-0.318C22.063,10.326,25.408,6.94,25.744,6.604z"/><path d="M19.375,0.235c0.336-0.335,0.584-0.363,0.584,0.264s0,4.555,0,5.067S19.943,6.1,19.662,6.381s-4.607,4.604-4.607,4.604s0-5.414,0-5.878c0-0.464,0.037-0.632,0.318-0.912C15.653,3.916,19.039,0.571,19.375,0.235z"/><path d="M1.621,16.53c-2.161,2.162-2.162,5.666-0.001,7.828c2.161,2.161,5.667,2.161,7.828,0c0.93-0.931,6.001-6,6.931-6.93c2.161-2.161,2.161-5.666,0-7.829c-2.162-2.162-5.666-2.161-7.828,0C7.621,10.531,2.551,15.6,1.621,16.53z"/></g></svg>`;
    case "hostileAircraftIntrusion":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(6,6) scale(1.6)"><path d="M31.207,0.82 C29.961,-0.43 27.771,-0.137 26.518,1.119 L20.141,7.481 L8.313,3.061 C7.18,2.768 6.039,2.389 4.634,3.798 C3.917,4.516 2.427,6.01 4.634,8.221 L12.744,14.861 L7.467,20.127 L2.543,18.896 C1.813,18.708 1.321,18.855 0.946,19.269 C0.757,19.505 -0.614,20.521 0.342,21.479 L6.067,25.933 L10.521,31.658 C11.213,32.352 11.856,31.919 12.735,31.084 C13.292,30.526 13.172,30.239 13.004,29.426 L11.892,24.536 L17.133,19.277 L23.763,27.389 C25.969,29.6 27.46,28.105 28.177,27.389 C29.583,25.979 29.205,24.837 28.912,23.702 L24.529,11.854 L30.88,5.481 C32.133,4.226 32.454,2.069 31.207,0.82"/></g></svg>`;
    case "terroristInfiltration":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(8,8) scale(0.09)"><path d="M460.401,45.34c1.653-1.652,2.582-3.894,2.582-6.232c0-2.337-0.928-4.579-2.582-6.232L442.155,14.63c-3.442-3.442-9.023-3.442-12.464,0l-7.477,7.477L402.686,2.581c-3.442-3.442-9.023-3.442-12.464,0l-18.695,18.695c-2.39,2.389-3.202,5.936-2.092,9.127l11.479,33.003l-40.917,40.918l-37.362,1.678c-2.199,0.099-4.281,1.016-5.837,2.572L51.599,353.775c-1.653,1.652-2.582,3.894-2.582,6.232v24.962c0,2.337,0.928,4.579,2.582,6.232l35.046,35.046c0.753,0.753,1.611,1.331,2.524,1.755l-0.004,0.007l18.33,8.51c6.621,3.074,11.828,8.472,14.663,15.197l23.136,54.893c0.91,2.158,2.641,3.865,4.81,4.745c1.062,0.431,2.187,0.646,3.312,0.646c1.173,0,2.344-0.234,3.445-0.702l41.303-17.54c4.105-1.743,6.261-6.279,5.02-10.563l-23.448-81l42.728-42.728c19.839,12.722,41.579,22.375,64.462,28.452c19.304,5.127,39.192,7.691,59.083,7.691c18.842,0,37.688-2.302,56.04-6.909c4.475-1.123,7.326-5.507,6.538-10.052l-11.508-66.435c-0.428-2.468-1.885-4.636-4.006-5.965c-2.123-1.329-4.71-1.692-7.115-1c-48.883,14.07-101.452,1.322-138.374-33.253l3.728-17.568L460.401,45.34z M396.455,21.278l13.294,13.294L394.761,49.56L387.9,29.833L396.455,21.278z M435.923,33.325l5.782,5.782L294.53,186.281l-5.782-5.782L435.923,33.325z M306.843,123.457l14.68-0.659l-45.238,45.238l-7.01-7.01L306.843,123.457z M92.877,407.55l-26.233-26.231v-17.661l138.868-138.868l28.105,28.105l-3.747,17.661L92.877,407.55z M184.079,480.591l-25.974,11.029L138.4,444.87c-4.54-10.772-12.88-19.416-23.483-24.338l-6.893-3.2l33.51-33.51l20.454,20.454L184.079,480.591z M169.825,387.181l-15.826-15.826l11.153-11.153l15.826,15.826L169.825,387.181z M193.443,363.563l-15.826-15.826l12.941-12.941c5.51,5.1,11.257,9.917,17.218,14.433L193.443,363.563z M381.338,324.614l8.459,48.828c-32.44,6.822-66.268,5.961-98.345-2.558c-32.927-8.744-63.326-25.458-88.433-48.548l35.102-35.102C276.983,322.076,330.39,335.998,381.338,324.614z M243.233,237.578l-25.256-25.256l38.834-38.832l25.256,25.255L243.233,237.578z"/><path d="M133.81,330.799c-3.442-3.442-9.023-3.442-12.464,0l-21.027,21.026c-3.442,3.442-3.442,9.022,0,12.464c1.722,1.722,3.977,2.582,6.232,2.582c2.255,0,4.511-0.86,6.232-2.582l21.027-21.026C137.252,339.821,137.252,334.241,133.81,330.799z"/></g></svg>`;
    case "earthQuake":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 44h10l6-10 6 8 6-12 6 8h14v6H41l-5-7-6 12-7-9-4 7H8z"/></svg>`;
    case "tsunami":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M6 40c6 0 6-5 12-5s6 5 12 5 6-5 12-5 6 5 12 5 6-5 12-5v8c-6 0-6 5-12 5s-6-5-12-5-6 5-12 5-6-5-12-5-6 5-12 5v-8z"/></svg>`;
    case "ended":
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 8C18.7 8 8 18.7 8 32s10.7 24 24 24 24-10.7 24-24S45.3 8 32 8zm-5 34-10-10 3.4-3.4L27 35.2l15.6-15.6L46 23 27 42z"/></svg>`;
    default:
      return `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 8l24 44H8z"/><rect x="29" y="24" width="6" height="16" rx="2" fill="#a50000"/><circle cx="32" cy="45" r="2.8" fill="#a50000"/></svg>`;
  }
}

function threatSevClass(type) {
  if (!type || type === "normal") return "warning";
  if (type === "ended") return "ended";
  return RED_TYPES.has(type) ? "alert" : "warning";
}

// ===== Helpers =====
function normName(s) {
  return String(s || "").replace(/[\u200f\u200e]/g, "").replace(/\s+/g, " ").trim();
}

function dateStr(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}`;
}

function timeStr(date) {
  return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function cityInAlert(alert) {
  if (!state.city || !Array.isArray(alert.cities)) return false;
  const needle = normName(state.city).toLowerCase();
  return alert.cities.some((c) => normName(c).toLowerCase() === needle);
}

function alertSeverity(type) {
  return RED_TYPES.has(type) ? "alert" : "warning";
}

// ===== Clock =====
function tickClock() {
  elClock.textContent = new Date().toLocaleTimeString("he-IL", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
setInterval(tickClock, 1000);
tickClock();

// ===== Status UI =====
const STATUS_CONFIG = {
  normal:  { bodyClass: "status-normal",  icon: "✓",  title: "מצב תקין",    sub: "" },
  warning: { bodyClass: "status-warning", icon: "⚠",  title: "אזהרה",        sub: "היכנס למרחב מוגן" },
  alert:   { bodyClass: "status-alert",   icon: "🚨", title: "צבע אדום",     sub: "היכנס מיד למרחב מוגן!" },
  ended:   { bodyClass: "status-ended",   icon: "✓",  title: "חזרה לשגרה",   sub: "האירוע הסתיים" },
};

function setStatus(newStatus, cities, instruction, type) {
  const prev = state.status;
  if (newStatus === prev && newStatus !== "normal") return;

  if (state.endedTimer && newStatus !== "ended" && newStatus !== "normal") {
    clearTimeout(state.endedTimer);
    state.endedTimer = null;
  }

  state.status = newStatus;
  const cfg = STATUS_CONFIG[newStatus];

  document.body.className = cfg.bodyClass;
  elStatusIcon.innerHTML  = (newStatus === "alert" || newStatus === "warning")
    ? getThreatSvg(type)
    : cfg.icon;
  elStatusTitle.textContent = cfg.title;
  elStatusSub.textContent   = cfg.sub || instruction || "";
  elStatusCities.textContent = cities && cities.length
    ? cities.slice(0, 6).join(" • ")
    : (newStatus === "normal" || newStatus === "ended") ? state.city || "" : "";

  if (newStatus !== prev) {
    addHistory(newStatus, cities, instruction, type);
    playTone(newStatus);
  }

  if (newStatus === "ended") {
    state.endedTimer = setTimeout(() => {
      state.endedTimer = null;
      setStatus("normal", [], "");
    }, ENDED_TTL_MS);
  }
}

// ===== History =====
function addHistory(statusType, cities, instruction, type) {
  const now = new Date();
  let text;
  if (statusType === "alert") {
    text = (instruction || "צבע אדום") + (cities && cities.length ? " — " + cities.slice(0, 4).join(", ") : "");
  } else if (statusType === "warning") {
    text = (instruction || "אזהרה") + (cities && cities.length ? " — " + cities.slice(0, 4).join(", ") : "");
  } else if (statusType === "ended") {
    text = "חזרה לשגרה" + (state.city ? " — " + state.city : "");
  } else {
    return;
  }
  const resolvedType = type || (statusType === "ended" ? "ended" : "general");
  state.history.unshift({ _ts: now.getTime(), time: timeStr(now), date: dateStr(now), type: resolvedType, text });
  if (state.history.length > MAX_HISTORY) state.history.pop();
  renderHistory();
}

function renderHistory() {
  if (state.history.length === 0) {
    elHistoryList.innerHTML = '<div class="history-item"><span class="history-text" style="opacity:0.6">אין אירועים עדיין</span></div>';
    return;
  }
  elHistoryList.innerHTML = state.history.map((h) => `
    <div class="history-item">
      <span class="history-icon threat-${threatSevClass(h.type)}">${getThreatSvg(h.type)}</span>
      <span class="history-datetime">
        <span class="history-time">${h.time}</span>
        <span class="history-date">${h.date || ""}</span>
      </span>
      <span class="history-text">${h.text}</span>
    </div>
  `).join("");
}
renderHistory();

// ===== oref.org.il API fetch (via proxy) =====
// The proxy (serve-static.js in dev, Cloudflare Worker in prod) forwards the raw
// arraybuffer from oref.org.il, so we decode manually here — handling UTF-16-LE BOM
// exactly as pikud-haoref-api/lib/alerts.js does.
async function fetchOrefJson(proxyUrl) {
  const res = await fetch(proxyUrl, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const buffer = await res.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  if (bytes.length === 0) return null;

  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(bytes.slice(2));
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder("utf-8").decode(bytes.slice(3));
  } else {
    text = new TextDecoder("utf-8").decode(bytes);
  }

  text = text.replace(/\x00/g, "").replace(/\u0a7b/g, "").trim();

  if (!text) return null;
  return JSON.parse(text);
}

// Parse Alerts.json → [{type, cities, instructions, id}]
function parseAlertsJson(json) {
  if (!json || !json.data || !Array.isArray(json.data)) return [];

  const type   = alertTypeByCategory(json.cat);
  const cities = json.data
    .map((c) => normName(c))
    .filter((c) => c && !c.includes("בדיקה"));

  if (cities.length === 0) return [];

  return [{
    id:           json.id ? String(json.id) : `oref-${Date.now()}`,
    type,
    instructions: json.title || "",
    cities,
  }];
}

// Parse AlertsHistory.json → [{type, cities, instructions, timestamp, id}] (only recent items)
function parseHistoryJson(json) {
  if (!Array.isArray(json) || json.length === 0) return [];

  const nowUnix = Math.round(Date.now() / 1000);
  const buckets = {};

  for (const item of json) {
    if (!item.alertDate || !item.data || !item.category) continue;

    // Timezone is Asia/Jerusalem — rely on JS Date parsing (oref sends local time strings)
    const parsed = new Date(item.alertDate);
    if (isNaN(parsed.getTime())) continue;   // skip items with unparseable dates
    const unix = parsed.getTime() / 1000;
    if (nowUnix - unix > HISTORY_MAX_AGE_S) continue;

    const city = normName(item.data);
    if (!city || city.includes("בדיקה")) continue;

    const cat = String(item.category);
    if (!buckets[cat]) {
      buckets[cat] = {
        id:           item.id ? String(item.id) : `oref-h-${cat}-${unix}`,
        type:         alertTypeByHistCategory(cat),
        instructions: item.title || "",
        cities:       [],
        timestamp:    new Date(unix * 1000).toISOString(),
      };
    }
    if (!buckets[cat].cities.includes(city)) buckets[cat].cities.push(city);
  }

  return Object.values(buckets).filter((a) => a.cities.length > 0);
}

// ===== Live alert processing =====
// Background color, tone, and status title only change for the selected city.
// If no city is selected, status stays "normal" regardless of incoming alerts.
function processLive(liveAlerts) {
  state._lastLive = liveAlerts;
  if (!state.city) return;

  const mine = liveAlerts.filter(cityInAlert);

  if (mine.length > 0) {
    const worst = mine.reduce(
      (acc, a) => alertSeverity(a.type) === "alert" ? a : acc,
      mine[0]
    );
    const sev    = alertSeverity(worst.type);
    const cities = [...new Set(mine.flatMap((a) => a.cities.map(normName)))];

    if (state.status === "normal" || state.status === "ended" ||
        (state.status === "warning" && sev === "alert")) {
      setStatus(sev, cities, worst.instructions, worst.type);
    } else if (state.status === sev) {
      elStatusCities.textContent = cities.slice(0, 6).join(" • ");
    }
  } else {
    // Only transition to "ended" if we were previously in an alert/warning for our city
    if (state.status === "alert" || state.status === "warning") {
      setStatus("ended", [], "");
    }
  }
}

// ===== History processing from API =====
function processApiHistory(histAlerts) {
  if (!state.city || histAlerts.length === 0) return;

  const needle = normName(state.city).toLowerCase();
  let added = 0;

  for (const item of histAlerts) {
    if (!item.cities.some((c) => normName(c).toLowerCase() === needle)) continue;
    const key = `${item.timestamp}_${item.id}_${item.type}`;
    if (state.shownHistoryIds.has(key)) continue;
    state.shownHistoryIds.add(key);

    const ts = Date.parse(item.timestamp) || 0;
    const d  = new Date(ts);
    state.history.push({ _ts: ts, time: timeStr(d), date: dateStr(d), type: item.type, text: item.instructions });
    added++;
  }

  if (added === 0) return;
  state.history.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  renderHistory();
}

// ===== Main poll =====
async function poll() {
  try {
    const [alertsResult, historyResult] = await Promise.allSettled([
      fetchOrefJson(ALERTS_URL),
      fetchOrefJson(HISTORY_URL),
    ]);

    let liveAlerts = [];
    let histAlerts = [];

    if (alertsResult.status === "fulfilled") {
      const json = alertsResult.value;
      if (json === null) {
        // Empty response = no active alert (check history for recent ones)
      } else if (Array.isArray(json)) {
        // Alerts.json returned an array — shouldn't happen but handle gracefully
        liveAlerts = [];
      } else {
        liveAlerts = parseAlertsJson(json);
      }
    } else {
      console.warn("[oref] Alerts.json fetch failed:", alertsResult.reason);
    }

    if (historyResult.status === "fulfilled" && Array.isArray(historyResult.value)) {
      histAlerts = parseHistoryJson(historyResult.value);
    } else if (historyResult.status === "rejected") {
      console.warn("[oref] AlertsHistory.json fetch failed:", historyResult.reason);
    }

    updateConnStatus(true);
    processApiHistory(histAlerts);
    processLive(liveAlerts);

  } catch (err) {
    console.warn("[oref] poll error:", err);
    updateConnStatus(false);
  }
}

function updateConnStatus(ok) {
  elConnStatus.textContent = ok ? "מחובר (oref.org.il)" : "שגיאת חיבור — מנסה שוב...";
}

setInterval(poll, POLL_MS);
poll();

// ===== Audio =====
function initAudio() {
  if (state.audioCtx) return;
  try {
    state.audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
    state.audioUnlocked = true;
    localStorage.setItem(STORAGE_AUDIO, "1");
    elAudioBtn.textContent = "שמע פעיל ✓";
    elAudioBtn.classList.add("audio-ready");
    elAudioBtn.disabled = true;
  } catch (e) {
    console.warn("AudioContext failed:", e);
  }
}

function beep(freq, durationSec, startTime, gainVal = 0.4) {
  if (!state.audioCtx) return;
  const ctx  = state.audioCtx;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainVal, startTime + 0.01);
  gain.gain.setValueAtTime(gainVal, startTime + durationSec - 0.03);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);
  osc.start(startTime);
  osc.stop(startTime + durationSec);
}

function playTone(statusType) {
  if (!state.audioCtx) return;
  if (state.audioCtx.state === "suspended") {
    state.audioCtx.resume().then(() => _playTone(statusType));
  } else {
    _playTone(statusType);
  }
}

function _playTone(statusType) {
  const ctx = state.audioCtx;
  const t   = ctx.currentTime + 0.05;
  if (statusType === "alert") {
    for (let i = 0; i < 4; i++) beep(880, 0.12, t + i * 0.22, 0.55);
    for (let i = 0; i < 4; i++) beep(880, 0.12, t + 1.1 + i * 0.22, 0.55);
  } else if (statusType === "warning") {
    beep(660, 0.2, t, 0.4);
    beep(660, 0.2, t + 0.4, 0.4);
  } else if (statusType === "ended") {
    beep(660, 0.25, t, 0.35);
    beep(440, 0.25, t + 0.3, 0.35);
    beep(330, 0.4, t + 0.6, 0.3);
  }
}

// ===== Wake Lock =====
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch (e) {
    console.warn("Wake lock failed:", e);
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.wakeLock) requestWakeLock();
});

// ===== City selector =====
let _validCities = [];

async function loadCities() {
  try {
    const res  = await fetch(ZONES_URL);
    const data = await res.json();
    _validCities = (data.cities || []).map((c) => normName(c.name)).filter(Boolean).sort();
    _validCities.forEach((name) => {
      const opt   = document.createElement("option");
      opt.value   = name;
      elCityOptions.appendChild(opt);
    });
    const saved = localStorage.getItem(STORAGE_CITY);
    if (saved && _validCities.includes(saved)) {
      elCityInput.value = saved;
      applyCity(saved);
    }
  } catch (e) {
    console.error("Failed to load cities:", e);
  }
}

function applyCity(name) {
  state.city = name;
  localStorage.setItem(STORAGE_CITY, name);
  elStatusCities.textContent = name;
  elSetupBarCity.textContent = name ? "עיר: " + name : "⚙ הגדרות";
  state.history = [];
  state.shownHistoryIds.clear();
  renderHistory();
  // Re-evaluate current live alerts for new city
  processLive(state._lastLive);
}

elCityInput.addEventListener("change", () => {
  const typed = normName(elCityInput.value);
  const match = _validCities.find((c) => c.toLowerCase() === typed.toLowerCase());
  if (match) { elCityInput.value = match; applyCity(match); }
});

elCityInput.addEventListener("input", () => {
  const typed = normName(elCityInput.value);
  const match = _validCities.find((c) => c.toLowerCase() === typed.toLowerCase());
  if (match) applyCity(match);
});

// ===== Audio unlock button =====
elAudioBtn.addEventListener("click", () => {
  initAudio();
  requestWakeLock();
  setTimeout(() => playTone("ended"), 100);
});

// ===== Pull-to-refresh =====
(function () {
  const THRESHOLD = 72;
  const ind = document.getElementById("ptr-indicator");
  let startY = 0, pullDy = 0, active = false;

  function reset(trigger) {
    if (trigger) {
      ind.textContent = "↻";
      ind.style.opacity = "1";
      ind.style.transform = "translate(-50%, 10px)";
      poll();
      setTimeout(() => {
        ind.style.transition = "opacity 0.3s, transform 0.3s";
        ind.style.opacity = "0";
        ind.style.transform = "translate(-50%, -52px)";
        setTimeout(() => { ind.style.transition = ""; }, 350);
      }, 600);
    } else {
      ind.style.opacity = "0";
      ind.style.transform = "translate(-50%, -52px)";
    }
    startY = 0; pullDy = 0; active = false;
  }

  document.addEventListener("touchstart", (e) => {
    const inHistory = elHistoryList.contains(e.target);
    if (inHistory && elHistoryList.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    active = true;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!active) return;
    pullDy = e.touches[0].clientY - startY;
    if (pullDy <= 0) { reset(false); return; }
    ind.style.opacity = String(Math.min(pullDy / THRESHOLD, 1));
    ind.style.transform = `translate(-50%, ${Math.min(pullDy * 0.45 - 52, 10)}px)`;
    ind.textContent = pullDy >= THRESHOLD ? "↑" : "↓";
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!active) return;
    reset(pullDy >= THRESHOLD);
  });
}());

// ===== Init =====
async function init() {
  await loadCities();
  requestWakeLock();

  if (localStorage.getItem(STORAGE_AUDIO)) {
    elAudioBtn.textContent = "הפעל שמע (נדרשת לחיצה)";
  }
}

init();

// ===== RSS Panel =====
const STORAGE_RSS_URL     = "shabbat_rss_url_v1";
const STORAGE_RSS_VISIBLE = "shabbat_rss_visible_v1";
const RSS_POLL_MS         = 60 * 1000;        // refresh every minute
const RSS_MAX_AGE_MS      = 12 * 60 * 60 * 1000; // show items from last 12 hours
const RSS_DEFAULT_URL     = "https://www.ynet.co.il/Integration/StoryRss1854.xml";
// CORS proxy — returns raw XML via ?url=
const RSS_CORS_PROXY = "https://api.allorigins.win/get?url=";

const elRssPanel        = $("rss-panel");
const elRssList         = $("rss-list");
const elRssLabel        = $("rss-label");
const elRssScrollTrack  = $("rss-scroll-track");
const elRssUrlInput     = $("rss-url-input");
const elRssSettingsBtn  = $("rss-settings-btn");
const elRssSettingsDrw  = $("rss-settings-drawer");
const elRssUrlSaveBtn   = $("rss-url-save-btn");
const elRssToggleBtn    = $("rss-toggle-btn");
const elRssShowBtn      = $("rss-show-btn");

const rssState = {
  url: "",
  items: [],
  pollTimer: null,
  scrollRaf: null,
  scrollPos: 0,       // current pixel offset from top of track
  totalHeight: 0,     // full height of rss-list in px
  containerHeight: 0, // visible container height in px
  speed: 0.5,         // px per animation frame (~30px/sec at 60fps)
  pauseUntil: 0,      // timestamp — pause scrolling until this time
};

function rssTimeStr(date) {
  return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function rssDateStr(date) {
  return date.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function renderRssItems() {
  if (rssState.items.length === 0) {
    elRssList.innerHTML = '<div class="rss-empty">אין פריטים להצגה</div>';
    return;
  }  elRssList.innerHTML = rssState.items.map((item) => {
    const d = item.pubDate ? new Date(item.pubDate) : null;
    const time = d && !isNaN(d) ? rssTimeStr(d) : "";
    const date = d && !isNaN(d) ? rssDateStr(d) : "";
    const title = (item.title || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<div class="rss-item">
      <div class="rss-item-meta">
        ${time ? `<span class="rss-item-time">${time}</span>` : ""}
        ${date ? `<span class="rss-item-date">${date}</span>` : ""}
      </div>
      <div class="rss-item-title">${title}</div>
    </div>`;
  }).join("");
}

// Parse raw RSS/Atom XML string → { feedTitle, items[] }
function parseRssXml(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, "application/xml");

  // Feed title: RSS <channel><title> or Atom <feed><title>
  const feedTitleEl = doc.querySelector("channel > title") || doc.querySelector("feed > title");
  const feedTitle   = feedTitleEl ? feedTitleEl.textContent.trim() : "";

  const cutoff = Date.now() - RSS_MAX_AGE_MS;
  const items  = [];

  // RSS <item> elements
  doc.querySelectorAll("item").forEach((el) => {
    const title   = (el.querySelector("title")   || {}).textContent || "";
    const pubDate = (el.querySelector("pubDate") || {}).textContent || "";
    const ts      = pubDate ? new Date(pubDate).getTime() : 0;
    if (ts && ts < cutoff) return; // skip items older than 12 hours
    items.push({ title: title.trim(), pubDate: pubDate.trim(), _ts: ts });
  });

  // Atom <entry> elements (fallback)
  if (items.length === 0) {
    doc.querySelectorAll("entry").forEach((el) => {
      const title   = (el.querySelector("title")   || {}).textContent || "";
      const updated = (el.querySelector("updated") || el.querySelector("published") || {}).textContent || "";
      const ts      = updated ? new Date(updated).getTime() : 0;
      if (ts && ts < cutoff) return;
      items.push({ title: title.trim(), pubDate: updated.trim(), _ts: ts });
    });
  }

  // Sort newest first
  items.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  return { feedTitle, items };
}

async function fetchRss() {
  if (!rssState.url) return;

  // Show loading indicator only on first load (no items yet)
  if (rssState.items.length === 0) {
    elRssList.innerHTML = '<div class="rss-empty rss-loading">טוען חדשות…</div>';
  }

  try {
    const proxyUrl = RSS_CORS_PROXY + encodeURIComponent(rssState.url);
    const res      = await fetch(proxyUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json     = await res.json();
    const xmlText  = json && json.contents ? json.contents : "";
    if (!xmlText) throw new Error("empty response");

    const { feedTitle, items } = parseRssXml(xmlText);

    rssState.items = items;
    if (feedTitle) elRssLabel.textContent = feedTitle;
    renderRssItems();
    resetRssScroll();
  } catch (e) {
    console.warn("[rss] fetch failed:", e);
    if (rssState.items.length === 0) {
      elRssList.innerHTML = '<div class="rss-empty">שגיאה בטעינת החדשות — מנסה שוב בעוד דקה</div>';
    }
  }
}

function startRssPoll() {
  if (rssState.pollTimer) clearInterval(rssState.pollTimer);
  fetchRss();
  rssState.pollTimer = setInterval(fetchRss, RSS_POLL_MS);
}

// ---- Auto-scroll logic ----
// Scrolls the rss-scroll-track upward continuously, then wraps back to top.
// Pauses briefly at the top when wrapping.

function resetRssScroll() {
  rssState.scrollPos = 0;
  elRssScrollTrack.style.transform = "translateY(0px)";
  refreshRssDimensions();
}

function refreshRssDimensions() {
  const container = $("rss-scroll-container");
  rssState.containerHeight = container ? container.clientHeight : 0;
  rssState.totalHeight     = elRssList ? elRssList.scrollHeight : 0;
}

const SCROLL_PAUSE_TOP_MS  = 2000; // pause at top
const SCROLL_PAUSE_BTM_MS  = 1000; // pause at bottom before wrap

function tickRssScroll(ts) {
  rssState.scrollRaf = requestAnimationFrame(tickRssScroll);

  if (ts < rssState.pauseUntil) return;

  refreshRssDimensions();

  const { containerHeight, totalHeight } = rssState;
  // Only scroll if content overflows
  if (totalHeight <= containerHeight) return;

  rssState.scrollPos += rssState.speed;
  const maxScroll = totalHeight - containerHeight;

  if (rssState.scrollPos >= maxScroll) {
    // Reached bottom — pause then wrap
    rssState.scrollPos    = maxScroll;
    rssState.pauseUntil   = ts + SCROLL_PAUSE_BTM_MS;
    elRssScrollTrack.style.transform = `translateY(-${rssState.scrollPos}px)`;
    setTimeout(() => {
      rssState.scrollPos  = 0;
      rssState.pauseUntil = performance.now() + SCROLL_PAUSE_TOP_MS;
      elRssScrollTrack.style.transform = "translateY(0px)";
    }, SCROLL_PAUSE_BTM_MS);
  } else {
    elRssScrollTrack.style.transform = `translateY(-${rssState.scrollPos}px)`;
  }
}

function startRssScroll() {
  if (rssState.scrollRaf) cancelAnimationFrame(rssState.scrollRaf);
  rssState.scrollPos  = 0;
  rssState.pauseUntil = performance.now() + SCROLL_PAUSE_TOP_MS;
  rssState.scrollRaf  = requestAnimationFrame(tickRssScroll);
}

function stopRssScroll() {
  if (rssState.scrollRaf) cancelAnimationFrame(rssState.scrollRaf);
  rssState.scrollRaf = null;
}

// ---- Panel show / hide ----
function showRssPanel() {
  elRssPanel.classList.remove("rss-hidden");
  localStorage.setItem(STORAGE_RSS_VISIBLE, "1");
  startRssScroll();
}

function hideRssPanel() {
  elRssPanel.classList.add("rss-hidden");
  localStorage.removeItem(STORAGE_RSS_VISIBLE);
  stopRssScroll();
}

// ---- Settings toggle ----
elRssSettingsBtn.addEventListener("click", () => {
  elRssSettingsDrw.classList.toggle("open");
});

// ---- Save RSS URL ----
elRssUrlSaveBtn.addEventListener("click", () => {
  const url = elRssUrlInput.value.trim();
  rssState.url = url;
  localStorage.setItem(STORAGE_RSS_URL, url);
  elRssSettingsDrw.classList.remove("open");
  if (url) {
    showRssPanel();
    startRssPoll();
  }
});

// ---- Hide panel button ----
elRssToggleBtn.addEventListener("click", () => {
  elRssSettingsDrw.classList.remove("open");
  hideRssPanel();
});

// ---- Show panel from setup bar ----
elRssShowBtn.addEventListener("click", () => {
  showRssPanel();
  if (rssState.items.length === 0) startRssPoll();
});

// ---- Init RSS from localStorage ----
(function initRss() {
  const savedUrl     = localStorage.getItem(STORAGE_RSS_URL) || RSS_DEFAULT_URL;
  const savedVisible = localStorage.getItem(STORAGE_RSS_VISIBLE) === "1";

  rssState.url = savedUrl;
  elRssUrlInput.value = savedUrl;

  renderRssItems(); // render empty state initially

  if (savedVisible) {
    showRssPanel();
    startRssPoll();
  }
}());
