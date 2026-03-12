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

// ===== Threat SVG icons =====
const THREAT_SVGS = {
  missiles: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 8.5 9.5H11V19l1 2 1-2V9.5h2.5L12 2zm-1.5 19.5h3l-.8-1.5h-1.4l-.8 1.5z"/></svg>`,
  hostileAircraftIntrusion: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`,
  terroristInfiltration: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
  hazardousMaterials: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  earthQuake: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,13 5,8 8,15 11,10 14,13 17,5 20,17 22,13"/></svg>`,
  tsunami: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17c3 0 3-2 6-2s3 2 6 2 3-2 6-2v2c-3 0-3 2-6 2s-3-2-6-2-3 2-6 2v-2zm0-4c3 0 3-2 6-2s3 2 6 2 3-2 6-2v2c-3 0-3 2-6 2s-3-2-6-2-3 2-6 2v-2zm13-4h-2c0-2.21-1.79-4-4-4S6 6.79 6 9H4c0-3.31 2.69-6 6-6V2h4v1c3.31 0 6 2.69 6 6z"/></svg>`,
  radiologicalEvent: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`,
  general: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
  ended: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14-4-4 1.41-1.41L10 13.17l6.59-6.59L18 8l-8 8z"/></svg>`,
};

function getThreatSvg(type) {
  if (!type || type === "normal") return THREAT_SVGS.general;
  if (type === "ended") return THREAT_SVGS.ended;
  const base = type.replace(/Drill$/, "");
  return THREAT_SVGS[base] || THREAT_SVGS.general;
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
  return `${date.getDate()}/${date.getMonth() + 1}`;
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
  elStatusIcon.textContent  = cfg.icon;
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
    const unix = new Date(item.alertDate).getTime() / 1000;
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
      // If Alerts.json was empty but history has very recent items → use as live
      if (liveAlerts.length === 0 && histAlerts.length > 0) {
        liveAlerts = histAlerts;
      }
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
