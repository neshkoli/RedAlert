// shabbat.js — Always-on Shabbat alert monitor
// Polls the Cloudflare Worker + TzevaAdom WebSocket,
// filters by selected city, drives background color + audio tones.

const BACKEND_URL   = "https://redalert-proxy.neshkoli.workers.dev";
const WS_URL        = "wss://ws.tzevaadom.co.il/socket?platform=WEB";
const ZONES_URL     = "./data/zones-lookup.json";
const POLL_MS       = 5000;
const ENDED_TTL_MS  = 60 * 1000;
const WS_TTL_MS     = 2 * 60 * 1000;
const MAX_HISTORY   = 40;
const STORAGE_CITY  = "shabbat_city_v1";
const STORAGE_AUDIO = "shabbat_audio_unlocked_v1";

// Alert types considered RED (immediate danger)
const RED_TYPES = new Set([
  "missiles", "terroristInfiltration", "hazardousMaterials",
  "hostileAircraftIntrusion", "radiologicalEvent", "tsunami", "earthQuake",
  "missilesDrill", "terroristInfiltrationDrill", "hazardousMaterialsDrill",
  "hostileAircraftIntrusionDrill", "radiologicalEventDrill",
  "tsunamiDrill", "earthQuakeDrill",
]);

// ===== State =====
const state = {
  city: "",                        // selected city (Hebrew name)
  status: "normal",                // "normal" | "warning" | "alert" | "ended"
  endedTimer: null,                // setTimeout handle for ended → normal
  history: [],                     // [{ _ts, time, icon, text }]
  shownHistoryIds: new Set(),      // API group IDs already added to history
  audioCtx: null,
  audioUnlocked: false,
  wakeLock: null,
  ws: {
    socket: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    liveAlerts: new Map(),         // id → { type, instructions, cities, _ts }
  },
};

// ===== DOM refs =====
const $ = (id) => document.getElementById(id);
const elClock        = $("clock");
const elStatusBox    = $("status-box");
const elStatusIcon   = $("status-icon");
const elStatusTitle  = $("status-title");
const elStatusSub    = $("status-subtitle");
const elStatusCities = $("status-cities");
const elHistoryList  = $("history-list");
const elCitySelect   = $("city-select");
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

// ===== Helpers =====
function normName(s) {
  return String(s || "").replace(/[\u200f\u200e]/g, "").replace(/\s+/g, " ").trim();
}

function cityInAlert(alert) {
  if (!state.city || !Array.isArray(alert.cities)) return false;
  const needle = normName(state.city).toLowerCase();
  return alert.cities.some((c) => normName(c).toLowerCase() === needle);
}

function alertSeverity(type) {
  return RED_TYPES.has(type) ? "alert" : "warning";
}

function timeStr(date) {
  return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

// ===== Clock =====
function tickClock() {
  const now = new Date();
  elClock.textContent = now.toLocaleTimeString("he-IL", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
setInterval(tickClock, 1000);
tickClock();

// ===== Status UI =====
const STATUS_CONFIG = {
  normal:  { bodyClass: "status-normal",  icon: "✓",  title: "מצב תקין",       sub: "" },
  warning: { bodyClass: "status-warning", icon: "⚠",  title: "אזהרה",           sub: "היכנס למרחב מוגן" },
  alert:   { bodyClass: "status-alert",   icon: "🚨", title: "צבע אדום",        sub: "היכנס מיד למרחב מוגן!" },
  ended:   { bodyClass: "status-ended",   icon: "✓",  title: "חזרה לשגרה",      sub: "האירוע הסתיים" },
};

function setStatus(newStatus, cities, instruction) {
  const prev = state.status;
  if (newStatus === prev && newStatus !== "normal") return; // no change (except normal can refresh cities)

  // Cancel pending ended→normal timer if status is escalating
  if (state.endedTimer && newStatus !== "ended" && newStatus !== "normal") {
    clearTimeout(state.endedTimer);
    state.endedTimer = null;
  }

  state.status = newStatus;
  const cfg = STATUS_CONFIG[newStatus];

  // Body class
  document.body.className = cfg.bodyClass;

  // Status box
  elStatusIcon.textContent  = cfg.icon;
  elStatusTitle.textContent = cfg.title;
  elStatusSub.textContent   = cfg.sub || (instruction || "");
  elStatusCities.textContent = cities && cities.length
    ? cities.slice(0, 6).join(" • ")
    : (newStatus === "normal" || newStatus === "ended") ? state.city || "" : "";

  // History entry
  if (newStatus !== prev) {
    addHistory(newStatus, cities, instruction);
    playTone(newStatus);
  }

  // Schedule ended → normal
  if (newStatus === "ended") {
    state.endedTimer = setTimeout(() => {
      state.endedTimer = null;
      setStatus("normal", [], "");
    }, ENDED_TTL_MS);
  }
}

// ===== History =====
function addHistory(statusType, cities, instruction) {
  const now = new Date();
  let icon, text;

  if (statusType === "alert") {
    icon = "🔴";
    text = (instruction || "צבע אדום") + (cities && cities.length ? " — " + cities.slice(0, 4).join(", ") : "");
  } else if (statusType === "warning") {
    icon = "🟠";
    text = (instruction || "אזהרה") + (cities && cities.length ? " — " + cities.slice(0, 4).join(", ") : "");
  } else if (statusType === "ended") {
    icon = "🟢";
    text = "חזרה לשגרה" + (state.city ? " — " + state.city : "");
  } else {
    return; // don't log "normal" resets
  }

  state.history.unshift({ _ts: now.getTime(), time: timeStr(now), icon, text });
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
      <span class="history-icon">${h.icon}</span>
      <span class="history-time">${h.time}</span>
      <span class="history-text">${h.text}</span>
    </div>
  `).join("");
}
renderHistory();

// ===== API history =====
function processApiHistory(payload) {
  if (!state.city || !Array.isArray(payload.history) || payload.history.length === 0) return;

  const needle = normName(state.city).toLowerCase();
  const groups = new Map(); // id → { _ts, type, instructions, cities[] }

  for (const item of payload.history) {
    if (!Array.isArray(item.cities) || item.cities.length === 0) continue;
    const match = item.cities.some((c) => normName(c).toLowerCase() === needle);
    if (!match) continue;

    const id = String(item.id || item.timestamp);
    const ts = Date.parse(item.timestamp) || 0;

    if (!groups.has(id)) {
      groups.set(id, { _ts: ts, type: item.type, instructions: item.instructions, cities: [...item.cities] });
    } else {
      const g = groups.get(id);
      if (ts > g._ts) g._ts = ts;
      for (const c of item.cities) {
        if (!g.cities.includes(c)) g.cities.push(c);
      }
    }
  }

  let added = 0;
  for (const [id, g] of groups) {
    if (state.shownHistoryIds.has(id)) continue;
    state.shownHistoryIds.add(id);
    const icon = alertSeverity(g.type) === "alert" ? "🔴" : "🟠";
    const date = new Date(g._ts);
    state.history.push({ _ts: g._ts, time: timeStr(date), icon, text: g.instructions + " — " + g.cities.slice(0, 4).join(", ") });
    added++;
  }

  if (added === 0) return;
  state.history.sort((a, b) => (b._ts || 0) - (a._ts || 0));
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  renderHistory();
}

// ===== Audio =====
function initAudio() {
  if (state.audioCtx) return;
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
  const ctx = state.audioCtx;
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
  const t = ctx.currentTime + 0.05;

  if (statusType === "alert") {
    // 4 urgent short beeps at 880Hz
    for (let i = 0; i < 4; i++) {
      beep(880, 0.12, t + i * 0.22, 0.55);
    }
    // second burst after a pause
    for (let i = 0; i < 4; i++) {
      beep(880, 0.12, t + 1.1 + i * 0.22, 0.55);
    }
  } else if (statusType === "warning") {
    // 2 medium beeps at 660Hz
    beep(660, 0.2, t, 0.4);
    beep(660, 0.2, t + 0.4, 0.4);
  } else if (statusType === "ended") {
    // descending resolution: 660 → 440 → 330
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
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (e) {
    console.warn("Wake lock failed:", e);
  }
}

// Re-acquire on tab visibility restore
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.wakeLock) {
    requestWakeLock();
  }
});

// ===== City selector =====
async function loadCities() {
  try {
    const res  = await fetch(ZONES_URL);
    const data = await res.json();
    const cities = (data.cities || []).map((c) => normName(c.name)).filter(Boolean).sort();
    cities.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      elCitySelect.appendChild(opt);
    });
    // Restore saved city
    const saved = localStorage.getItem(STORAGE_CITY);
    if (saved) {
      elCitySelect.value = saved;
      state.city = saved;
      elSetupBarCity.textContent = "עיר: " + saved;
    }
  } catch (e) {
    console.error("Failed to load cities:", e);
  }
}

elCitySelect.addEventListener("change", () => {
  state.city = elCitySelect.value;
  localStorage.setItem(STORAGE_CITY, state.city);
  elStatusCities.textContent = state.city;
  elSetupBarCity.textContent = state.city ? "עיר: " + state.city : "⚙ הגדרות";
  // Reset history and re-load from last payload for new city
  state.history = [];
  state.shownHistoryIds.clear();
  renderHistory();
  if (state._lastPayload) processPayload(state._lastPayload);
});

// ===== Alert processing =====
function mergeAlerts(apiLive) {
  // Combine API live alerts with WS live alerts
  const all = [...(apiLive || [])];
  const now = Date.now();
  for (const [, alert] of state.ws.liveAlerts) {
    if (alert._ts && now - alert._ts < WS_TTL_MS) {
      all.push(alert);
    }
  }
  return all;
}

function processPayload(payload) {
  state._lastPayload = payload;
  processApiHistory(payload);
  if (!state.city) return;

  const live   = mergeAlerts(payload.live || []);
  const mine   = live.filter(cityInAlert);

  if (mine.length > 0) {
    // Pick worst severity (alert > warning)
    const worst = mine.reduce((acc, a) => {
      return alertSeverity(a.type) === "alert" ? a : acc;
    }, mine[0]);

    const sev    = alertSeverity(worst.type);
    const cities = [...new Set(mine.flatMap((a) => a.cities.map(normName)))];

    // Only transition if severity is higher or status is currently normal/ended
    if (state.status === "normal" || state.status === "ended" ||
        (state.status === "warning" && sev === "alert")) {
      setStatus(sev, cities, worst.instructions);
    } else if (state.status === sev) {
      // update cities display without re-triggering tone
      elStatusCities.textContent = cities.slice(0, 6).join(" • ");
    }
  } else {
    // No active alerts for our city
    if (state.status === "alert" || state.status === "warning") {
      setStatus("ended", [], "");
    }
  }
}

// ===== API Polling =====
async function poll() {
  try {
    const res  = await fetch(BACKEND_URL, { cache: "no-store" });
    const data = await res.json();
    updateConnStatus(true);
    processPayload(data);
  } catch (e) {
    updateConnStatus(false);
  }
}

function updateConnStatus(ok) {
  if (ok) {
    elConnStatus.textContent = state.ws.socket && state.ws.socket.readyState === WebSocket.OPEN
      ? "מחובר (חי + סקר)"
      : "מחובר (סקר)";
  } else {
    elConnStatus.textContent = "שגיאת חיבור — מנסה שוב...";
  }
}

setInterval(poll, POLL_MS);
poll();

// ===== WebSocket =====
function connectWs() {
  if (state.ws.socket) {
    state.ws.socket.close();
    state.ws.socket = null;
  }

  const ws = new WebSocket(WS_URL);
  state.ws.socket = ws;

  ws.addEventListener("open", () => {
    state.ws.reconnectDelay = 1000;
    updateConnStatus(true);
  });

  ws.addEventListener("message", (evt) => {
    try {
      const raw = JSON.parse(evt.data);
      const alert = normalizeWsAlert(raw);
      if (!alert) return;
      state.ws.liveAlerts.set(alert.id, alert);
      if (state._lastPayload) processPayload(state._lastPayload);
    } catch (_) {}
  });

  ws.addEventListener("close", () => {
    state.ws.socket = null;
    scheduleWsReconnect();
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function scheduleWsReconnect() {
  clearTimeout(state.ws.reconnectTimer);
  state.ws.reconnectTimer = setTimeout(() => {
    connectWs();
    state.ws.reconnectDelay = Math.min(state.ws.reconnectDelay * 1.5, 30000);
  }, state.ws.reconnectDelay);
}

// Prune stale WS alerts periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of state.ws.liveAlerts) {
    if (!a._ts || now - a._ts > WS_TTL_MS) state.ws.liveAlerts.delete(k);
  }
}, 30000);

function normalizeWsAlert(raw) {
  if (!raw || !Array.isArray(raw.cities) || raw.cities.length === 0) return null;
  const THREAT_TITLE = {
    0: "צבע אדום", 1: "אירוע חומרים מסוכנים", 2: "חשש לחדירת מחבלים",
    3: "רעידת אדמה", 4: "חשש לצונאמי", 5: "חדירת כלי טיס עוין",
    6: "חשש לאירוע רדיולוגי", 7: "ירי בלתי קונבנציונלי",
    8: "התרעה", 9: "תרגיל פיקוד העורף",
  };
  const THREAT_TYPE = {
    0: "missiles", 1: "hazardousMaterials", 2: "terroristInfiltration",
    3: "earthQuake", 4: "tsunami", 5: "hostileAircraftIntrusion",
    6: "radiologicalEvent", 7: "general", 8: "general", 9: "generalDrill",
  };
  const threat = Number(raw.threat);
  const isDrill = !!raw.isDrill;
  const baseType = THREAT_TYPE[threat] || "general";
  const type = isDrill && !baseType.endsWith("Drill") ? baseType + "Drill" : baseType;
  const cities = raw.cities.map(normName).filter(Boolean);
  if (!cities.length) return null;
  return {
    id: raw.notificationId || `ws-${Date.now()}-${type}`,
    type,
    instructions: THREAT_TITLE[threat] || "התרעה",
    cities,
    _ts: Date.now(),
  };
}

// ===== Audio unlock button =====
elAudioBtn.addEventListener("click", () => {
  initAudio();
  requestWakeLock();
  // Play a short test tone to confirm
  setTimeout(() => playTone("ended"), 100);
});

// ===== Init =====
async function init() {
  await loadCities();
  connectWs();
  requestWakeLock();

  // If audio was previously unlocked (same session won't help, but shows state)
  if (localStorage.getItem(STORAGE_AUDIO)) {
    // Audio context must still be created on user gesture, but hint the user
    elAudioBtn.textContent = "הפעל שמע (נדרשת לחיצה)";
  }
}

init();
