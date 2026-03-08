const ISRAEL_CENTER = [31.765352, 34.988067];
const REFRESH_MS = 5000;
const ENDED_TTL_MS = 60 * 1000;
const STALE_ALERT_MS = 15 * 60 * 1000;
const MAX_HISTORY_ITEMS = 1000;
const CIRCLE_RADIUS_METERS = 1500;
const MAX_VISIBLE_CITIES_IN_CARD = 8;
const STORAGE_KEY = "pikud_selected_locations_v1";
const ALERT_SETTINGS_KEY = "pikud_alert_settings_v1";
const ALERTS_STATE_KEY = "pikud_alerts_state_v1";
const DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "true";
const TEST_ALERT_TYPES = [
  "missiles",
  "newsFlash",
  "earlyWarning",
  "general",
  "earthQuake",
  "radiologicalEvent",
  "tsunami",
  "hostileAircraftIntrusion",
  "hazardousMaterials",
  "terroristInfiltration",
  "missilesDrill",
  "generalDrill",
  "earthQuakeDrill",
  "radiologicalEventDrill",
  "tsunamiDrill",
  "hostileAircraftIntrusionDrill",
  "hazardousMaterialsDrill",
  "terroristInfiltrationDrill",
  "unknown",
];

const state = {
  selectedLocations: new Set(),
  zonesLookup: [],
  alertsPayload: null,
  markerLayer: null,
  apiConsoleVisible: false,
  testMode: false,
  testPayload: null,
  expandedHistoryGroups: new Set(),
  notifiedAlertKeys: new Set(),
  popupTimer: null,
  alertSettings: {
    soundEnabled: true,
    notificationsEnabled: true,
  },
};

const map = L.map("map", {
  zoomControl: true,
  minZoom: 6,
  maxZoom: 13,
}).setView(ISRAEL_CENTER, 8);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

state.markerLayer = L.layerGroup().addTo(map);

function normalizeName(value) {
  return String(value || "")
    .replace(/\u200f|\u200e/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNewsFlash(type) {
  return type === "newsFlash" || type === "earlyWarning";
}

// ---------------------------------------------------------------------------
// Alert state management (runs in-browser, persisted to localStorage)
// ---------------------------------------------------------------------------

function isEndedInstruction(instructions) {
  return normalizeName(instructions) === "האירוע הסתיים";
}

function isNewsFlashType(type) {
  return type === "newsFlash" || type === "earlyWarning";
}

function typePriority(type) {
  return isNewsFlashType(type) ? 1 : 2;
}

function zonePriority(candidate) {
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

function getHistorySignature(item) {
  return [
    normalizeName(item.name),
    item.state || "unknown",
    item.alertType || "unknown",
    normalizeName(item.instructions || ""),
  ].join("|");
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
    const existingTs = new Date(existing.timestamp || 0).getTime();
    const incomingTs = new Date(item.timestamp || 0).getTime();
    if (incomingTs >= existingTs) {
      bySignature.set(key, { ...existing, ...item, timestamp: item.timestamp });
    }
  }

  const sorted = Array.from(bySignature.values()).sort((a, b) => {
    return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
  });

  return sorted.slice(0, MAX_HISTORY_ITEMS);
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
    const targetName = normalizeName(zone.name);
    const targetType = zone.alertType || "unknown";
    const targetInstructions = normalizeName(zone.instructions);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (!item) continue;
      const itemTs = new Date(item.timestamp || 0).getTime();
      if (!itemTs || now - itemTs > lookbackMs) break;
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
      zone: zone.zone || null,
      lat: zone.lat != null ? zone.lat : null,
      lng: zone.lng != null ? zone.lng : null,
    });
  }

  for (const key of Object.keys(currentByName)) {
    const current = currentByName[key];
    const prev = previousByName[key];
    const lookup = lookupByName ? lookupByName[key] : null;
    const currentIsEnded = current.state === "ended";
    seen.add(key);

    if (currentIsEnded) {
      if (!prev || prev.state !== "ended") {
        const historyZone = {
          ...current,
          lat: lookup ? lookup.lat : prev && prev.lat != null ? prev.lat : null,
          lng: lookup ? lookup.lng : prev && prev.lng != null ? prev.lng : null,
          zone: lookup ? lookup.zone : prev && prev.zone ? prev.zone : null,
        };
        if (!hasRecentHistoryEvent(historyZone, "ended", 30 * 60 * 1000)) {
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
    if (prev.state !== "active") continue;

    const lastSeenAtMs = new Date(prev.lastSeenAt || prev.startedAt || 0).getTime();
    if (lastSeenAtMs > 0 && now - lastSeenAtMs <= STALE_ALERT_MS) {
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

function loadAlertsState() {
  try {
    const raw = localStorage.getItem(ALERTS_STATE_KEY);
    if (!raw) return { zones: [], history: [] };
    return JSON.parse(raw);
  } catch (_err) {
    return { zones: [], history: [] };
  }
}

function saveAlertsState(zonesAndHistory) {
  try {
    localStorage.setItem(ALERTS_STATE_KEY, JSON.stringify(zonesAndHistory));
  } catch (_err) {
    // localStorage full or unavailable — skip silently
  }
}

function getAlertTypeLabel(type) {
  const map = {
    missiles: "ירי טילים",
    newsFlash: "הודעת התרעה מוקדמת",
    earlyWarning: "התרעה מוקדמת",
    general: "התרעה כללית",
    earthQuake: "רעידת אדמה",
    radiologicalEvent: "אירוע רדיולוגי",
    tsunami: "צונאמי",
    hostileAircraftIntrusion: "חדירת כלי טיס עוין",
    hazardousMaterials: "חומרים מסוכנים",
    terroristInfiltration: "חדירת מחבלים",
    missilesDrill: "תרגיל ירי טילים",
    generalDrill: "תרגיל התרעה כללית",
    earthQuakeDrill: "תרגיל רעידת אדמה",
    radiologicalEventDrill: "תרגיל אירוע רדיולוגי",
    tsunamiDrill: "תרגיל צונאמי",
    hostileAircraftIntrusionDrill: "תרגיל חדירת כלי טיס עוין",
    hazardousMaterialsDrill: "תרגיל חומרים מסוכנים",
    terroristInfiltrationDrill: "תרגיל חדירת מחבלים",
    unknown: "לא ידוע",
  };
  return map[type] || type || "לא ידוע";
}

function getStateLabel(alertState) {
  if (alertState === "active") return "פעיל";
  if (alertState === "ended") return "הסתיים";
  if (alertState === "expired") return "פג תוקף";
  return state || "לא ידוע";
}

function getMarkerColor(zone) {
  if (zone.state === "ended") return "#23a55a";
  if (isNewsFlash(zone.alertType)) return "#ff9800";
  return "#ff3b30";
}

function getZoneSeverity(zone) {
  if (zone.state === "ended") return 1;
  if (zone.alertType === "missiles") return 5;
  if (zone.alertType === "hostileAircraftIntrusion") return 4;
  if (zone.alertType === "earthQuake" || zone.alertType === "tsunami") return 3;
  if (isNewsFlash(zone.alertType)) return 2;
  return 2;
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function createClusterFromZone(zone) {
  return {
    zones: [zone],
    latSum: zone.lat,
    lngSum: zone.lng,
    centerLat: zone.lat,
    centerLng: zone.lng,
    maxDistanceFromCenter: 0,
  };
}

function recomputeClusterCenter(cluster) {
  cluster.centerLat = cluster.latSum / cluster.zones.length;
  cluster.centerLng = cluster.lngSum / cluster.zones.length;

  let maxDistance = 0;
  for (const z of cluster.zones) {
    const d = getDistanceMeters(cluster.centerLat, cluster.centerLng, z.lat, z.lng);
    if (d > maxDistance) maxDistance = d;
  }
  cluster.maxDistanceFromCenter = maxDistance;
}

function clusterZonesByDistance(zones) {
  const valid = (zones || []).filter((z) => z && z.lat != null && z.lng != null);
  const clusters = [];

  for (const zone of valid) {
    let target = null;
    let bestDistance = Infinity;

    for (const cluster of clusters) {
      const distance = getDistanceMeters(zone.lat, zone.lng, cluster.centerLat, cluster.centerLng);
      if (distance <= CIRCLE_RADIUS_METERS && distance < bestDistance) {
        target = cluster;
        bestDistance = distance;
      }
    }

    if (!target) {
      clusters.push(createClusterFromZone(zone));
      continue;
    }

    target.zones.push(zone);
    target.latSum += zone.lat;
    target.lngSum += zone.lng;
    recomputeClusterCenter(target);
  }

  return clusters.map((cluster) => {
    const leadZone = cluster.zones.reduce((best, current) =>
      getZoneSeverity(current) > getZoneSeverity(best) ? current : best
    );
    const radius = Math.max(
      CIRCLE_RADIUS_METERS,
      cluster.maxDistanceFromCenter + CIRCLE_RADIUS_METERS * 0.9
    );
    return {
      zones: cluster.zones,
      centerLat: cluster.centerLat,
      centerLng: cluster.centerLng,
      radius,
      leadZone,
    };
  });
}

function getAlertTypeIconSvg(alertType) {
  if (alertType === "missiles") {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g transform="translate(8,8) scale(1.9)">
          <path d="M25.744,6.604C26.08,6.267,26.107,6.02,25.48,6.02c-0.628,0-4.556,0-5.068,0
          c-0.512,0-0.533,0.016-0.814,0.297c-0.281,0.281-4.604,4.607-4.604,4.607s5.413,0,5.877,0c0.465,0,0.633-0.037,0.912-0.318
          C22.063,10.326,25.408,6.94,25.744,6.604z"/>
          <path d="M19.375,0.235c0.336-0.335,0.584-0.363,0.584,0.264s0,4.555,0,5.067S19.943,6.1,19.662,6.381
          s-4.607,4.604-4.607,4.604s0-5.414,0-5.878c0-0.464,0.037-0.632,0.318-0.912C15.653,3.916,19.039,0.571,19.375,0.235z"/>
          <path d="M1.621,16.53c-2.161,2.162-2.162,5.666-0.001,7.828c2.161,2.161,5.667,2.161,7.828,0
          c0.93-0.931,6.001-6,6.931-6.93c2.161-2.161,2.161-5.666,0-7.829c-2.162-2.162-5.666-2.161-7.828,0
          C7.621,10.531,2.551,15.6,1.621,16.53z"/>
        </g>
      </svg>`;
  }

  if (alertType === "hostileAircraftIntrusion") {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g transform="translate(6,6) scale(1.6)">
          <path d="M31.207,0.82 C29.961,-0.43 27.771,-0.137 26.518,1.119 L20.141,7.481 L8.313,3.061 C7.18,2.768 6.039,2.389 4.634,3.798 C3.917,4.516 2.427,6.01 4.634,8.221 L12.744,14.861 L7.467,20.127 L2.543,18.896 C1.813,18.708 1.321,18.855 0.946,19.269 C0.757,19.505 -0.614,20.521 0.342,21.479 L6.067,25.933 L10.521,31.658 C11.213,32.352 11.856,31.919 12.735,31.084 C13.292,30.526 13.172,30.239 13.004,29.426 L11.892,24.536 L17.133,19.277 L23.763,27.389 C25.969,29.6 27.46,28.105 28.177,27.389 C29.583,25.979 29.205,24.837 28.912,23.702 L24.529,11.854 L30.88,5.481 C32.133,4.226 32.454,2.069 31.207,0.82"/>
        </g>
      </svg>`;
  }

  if (alertType === "terroristInfiltration") {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g transform="translate(8,8) scale(0.09)">
          <path d="M460.401,45.34c1.653-1.652,2.582-3.894,2.582-6.232c0-2.337-0.928-4.579-2.582-6.232L442.155,14.63
          c-3.442-3.442-9.023-3.442-12.464,0l-7.477,7.477L402.686,2.581c-3.442-3.442-9.023-3.442-12.464,0l-18.695,18.695
          c-2.39,2.389-3.202,5.936-2.092,9.127l11.479,33.003l-40.917,40.918l-37.362,1.678c-2.199,0.099-4.281,1.016-5.837,2.572
          L51.599,353.775c-1.653,1.652-2.582,3.894-2.582,6.232v24.962c0,2.337,0.928,4.579,2.582,6.232l35.046,35.046
          c0.753,0.753,1.611,1.331,2.524,1.755l-0.004,0.007l18.33,8.51c6.621,3.074,11.828,8.472,14.663,15.197l23.136,54.893
          c0.91,2.158,2.641,3.865,4.81,4.745c1.062,0.431,2.187,0.646,3.312,0.646c1.173,0,2.344-0.234,3.445-0.702l41.303-17.54
          c4.105-1.743,6.261-6.279,5.02-10.563l-23.448-81l42.728-42.728c19.839,12.722,41.579,22.375,64.462,28.452
          c19.304,5.127,39.192,7.691,59.083,7.691c18.842,0,37.688-2.302,56.04-6.909c4.475-1.123,7.326-5.507,6.538-10.052l-11.508-66.435
          c-0.428-2.468-1.885-4.636-4.006-5.965c-2.123-1.329-4.71-1.692-7.115-1c-48.883,14.07-101.452,1.322-138.374-33.253l3.728-17.568
          L460.401,45.34z M396.455,21.278l13.294,13.294L394.761,49.56L387.9,29.833L396.455,21.278z M435.923,33.325l5.782,5.782
          L294.53,186.281l-5.782-5.782L435.923,33.325z M306.843,123.457l14.68-0.659l-45.238,45.238l-7.01-7.01L306.843,123.457z
          M92.877,407.55l-26.233-26.231v-17.661l138.868-138.868l28.105,28.105l-3.747,17.661L92.877,407.55z M184.079,480.591
          l-25.974,11.029L138.4,444.87c-4.54-10.772-12.88-19.416-23.483-24.338l-6.893-3.2l33.51-33.51l20.454,20.454L184.079,480.591z
          M169.825,387.181l-15.826-15.826l11.153-11.153l15.826,15.826L169.825,387.181z M193.443,363.563l-15.826-15.826l12.941-12.941
          c5.51,5.1,11.257,9.917,17.218,14.433L193.443,363.563z M381.338,324.614l8.459,48.828c-32.44,6.822-66.268,5.961-98.345-2.558
          c-32.927-8.744-63.326-25.458-88.433-48.548l35.102-35.102C276.983,322.076,330.39,335.998,381.338,324.614z M243.233,237.578
          l-25.256-25.256l38.834-38.832l25.256,25.255L243.233,237.578z"/>
          <path d="M133.81,330.799c-3.442-3.442-9.023-3.442-12.464,0l-21.027,21.026c-3.442,3.442-3.442,9.022,0,12.464
          c1.722,1.722,3.977,2.582,6.232,2.582c2.255,0,4.511-0.86,6.232-2.582l21.027-21.026
          C137.252,339.821,137.252,334.241,133.81,330.799z"/>
        </g>
      </svg>`;
  }

  if (alertType === "earthQuake") {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#fff" d="M8 44h10l6-10 6 8 6-12 6 8h14v6H41l-5-7-6 12-7-9-4 7H8z"/>
      </svg>`;
  }

  if (alertType === "tsunami") {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path fill="#fff" d="M6 40c6 0 6-5 12-5s6 5 12 5 6-5 12-5 6 5 12 5 6-5 12-5v8c-6 0-6 5-12 5s-6-5-12-5-6 5-12 5-6-5-12-5-6 5-12 5v-8z"/>
      </svg>`;
  }

  // newsFlash / earlyWarning / fallback
  return `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path fill="#fff" d="M32 8l24 44H8z"/>
      <rect x="29" y="24" width="6" height="16" rx="2" fill="#a50000"/>
      <circle cx="32" cy="45" r="2.8" fill="#a50000"/>
    </svg>`;
}

function createAlertTypeIconMarker(cluster, color) {
  const colorWithOpacity = hexToRgba(color, 0.5);
  const iconHtml = `
    <div class="alert-type-icon" style="background:${colorWithOpacity}">
      ${getAlertTypeIconSvg(cluster.leadZone.alertType)}
    </div>`;

  return L.marker([cluster.centerLat, cluster.centerLng], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      html: iconHtml,
      className: "alert-type-icon-wrapper",
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
  });
}

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
    return `rgba(255,0,0,${alpha})`;
  }

  let value = hex.slice(1);
  if (value.length === 3) {
    value = value
      .split("")
      .map((x) => x + x)
      .join("");
  }
  if (value.length !== 6) {
    return `rgba(255,0,0,${alpha})`;
  }

  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getHistoryItemClass(eventItem) {
  if (eventItem.state === "ended" || eventItem.state === "expired") return "green";
  if (isNewsFlash(eventItem.alertType)) return "orange";
  return "red";
}

function buildHistoryGroups(historyEvents) {
  const grouped = new Map();

  for (const event of historyEvents || []) {
    const timestamp = event.timestamp || event.startedAt || null;
    // Group by alert identity (type + instructions + state + reason + zone),
    // so all cities in the same zone/alert collapse into one card.
    const zoneName = event.zone || null;
    const keyParts = [
      event.state || "unknown",
      event.alertType || "unknown",
      normalizeName(event.instructions || ""),
      event.reason || "",
      zoneName || "",
    ];
    const key = keyParts.join("|");

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        timestamp,
        state: event.state || "unknown",
        alertType: event.alertType || "unknown",
        instructions: event.instructions || null,
        zone: zoneName,
        cities: [],
        coordinates: [],
      });
    }

    const group = grouped.get(key);

    // Keep the latest timestamp for the card header
    if (timestamp && (!group.timestamp || timestamp > group.timestamp)) {
      group.timestamp = timestamp;
    }

    const cityName = event.name || "";
    if (cityName && !group.cities.includes(cityName)) {
      group.cities.push(cityName);
    }

    if (event.lat != null && event.lng != null) {
      group.coordinates.push([event.lat, event.lng]);
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const left = new Date(a.timestamp || 0).getTime();
    const right = new Date(b.timestamp || 0).getTime();
    return right - left;
  });
}

function getSelectedArray() {
  return Array.from(state.selectedLocations);
}

function saveSelectedLocations() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getSelectedArray()));
}

function loadSelectedLocations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item) state.selectedLocations.add(item);
      }
    }
  } catch (_err) {
    // ignore malformed localStorage data
  }
}

function formatIso(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("he-IL");
}

function ensureNotificationPermission() {
  if (!state.alertSettings.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function playWarningSound() {
  if (!state.alertSettings.soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    for (let i = 0; i < 3; i += 1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.35, now + i * 0.25 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.25 + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.25);
      osc.stop(now + i * 0.25 + 0.2);
    }
  } catch (_err) {
    // ignore audio permission/runtime failures
  }
}

function showWarningPopup(matches) {
  const popup = document.getElementById("warningPopup");
  if (!popup) return;

  const cities = matches.map((m) => m.name);
  const first = cities.slice(0, 5).join(", ");
  const more = cities.length > 5 ? ` ועוד ${cities.length - 5}` : "";
  popup.textContent = `אזהרה: התראה עבור המיקומים שלך - ${first}${more}`;
  popup.classList.remove("hidden");

  if (state.popupTimer) {
    clearTimeout(state.popupTimer);
  }
  state.popupTimer = setTimeout(() => {
    popup.classList.add("hidden");
  }, 5000);
}

function showSystemNotification(matches) {
  if (!state.alertSettings.notificationsEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  const cities = matches.map((m) => m.name);
  const body = cities.slice(0, 6).join(", ") + (cities.length > 6 ? ` ועוד ${cities.length - 6}` : "");
  try {
    const n = new Notification("התראת פיקוד העורף למיקום שבחרת", { body });
    setTimeout(() => n.close(), 5000);
  } catch (_err) {
    // ignore notification errors
  }
}

function loadAlertSettings() {
  try {
    const raw = localStorage.getItem(ALERT_SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.soundEnabled === "boolean") {
      state.alertSettings.soundEnabled = parsed.soundEnabled;
    }
    if (typeof parsed.notificationsEnabled === "boolean") {
      state.alertSettings.notificationsEnabled = parsed.notificationsEnabled;
    }
  } catch (_err) {
    // ignore malformed settings
  }
}

function saveAlertSettings() {
  localStorage.setItem(ALERT_SETTINGS_KEY, JSON.stringify(state.alertSettings));
}

function syncAlertSettingsUI() {
  const soundToggle = document.getElementById("soundToggle");
  const notificationToggle = document.getElementById("notificationToggle");
  if (soundToggle) {
    soundToggle.checked = !!state.alertSettings.soundEnabled;
  }
  if (notificationToggle) {
    notificationToggle.checked = !!state.alertSettings.notificationsEnabled;
  }
}

function triggerLocationAlertsIfNeeded(zones) {
  const selected = new Set(getSelectedArray().map((x) => normalizeName(x)));
  if (selected.size === 0) return;

  const activeMatches = (zones || []).filter(
    (z) => z && z.state === "active" && selected.has(normalizeName(z.name))
  );
  if (activeMatches.length === 0) {
    state.notifiedAlertKeys = new Set();
    return;
  }

  const currentKeys = new Set(
    activeMatches.map((z) => `${z.normalizedName || normalizeName(z.name)}|${z.alertType || "unknown"}|${z.startedAt || ""}`)
  );
  const nextNotified = new Set();
  const newMatches = [];

  for (const match of activeMatches) {
    const key = `${match.normalizedName || normalizeName(match.name)}|${match.alertType || "unknown"}|${match.startedAt || ""}`;
    if (state.notifiedAlertKeys.has(key)) {
      nextNotified.add(key);
      continue;
    }
    newMatches.push(match);
    nextNotified.add(key);
  }

  // Keep only keys that are still active.
  for (const key of nextNotified) {
    if (!currentKeys.has(key)) {
      nextNotified.delete(key);
    }
  }
  state.notifiedAlertKeys = nextNotified;

  if (newMatches.length > 0) {
    playWarningSound();
    showWarningPopup(newMatches);
    showSystemNotification(newMatches);
  }
}

function renderCityOptions() {
  const datalist = document.getElementById("cityOptions");
  datalist.innerHTML = "";
  const names = state.zonesLookup.map((c) => c.name).sort((a, b) => a.localeCompare(b, "he"));
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    datalist.appendChild(option);
  }
}

function renderSelectedLocations(zones) {
  const container = document.getElementById("selectedLocations");
  container.innerHTML = "";
  const byName = {};
  for (const z of zones) byName[z.normalizedName] = z;

  for (const location of getSelectedArray()) {
    const normalized = normalizeName(location);
    const zone = byName[normalized];

    const tag = document.createElement("span");
    tag.className = "tag";
    if (zone) {
      tag.classList.add(zone.state === "ended" ? "ended-alert" : isNewsFlash(zone.alertType) ? "news-alert" : "active-alert");
    }

    const text = document.createElement("span");
    text.textContent = location;
    tag.appendChild(text);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "x";
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => {
      state.selectedLocations.delete(location);
      saveSelectedLocations();
      renderSelectedLocations(zones);
    });
    tag.appendChild(removeBtn);

    container.appendChild(tag);
  }
}

function renderMarkers(zones) {
  state.markerLayer.clearLayers();
  const clusters = clusterZonesByDistance(zones);

  for (const cluster of clusters) {
    const color = getMarkerColor(cluster.leadZone);
    const cityNames = cluster.zones.map((z) => z.name);
    const preview = cityNames.slice(0, MAX_VISIBLE_CITIES_IN_CARD).join(", ");
    const more = cityNames.length > MAX_VISIBLE_CITIES_IN_CARD ? `<br/>ועוד ${cityNames.length - MAX_VISIBLE_CITIES_IN_CARD} יישובים` : "";
    const instructions = cluster.leadZone.instructions || null;
    const popupHeader =
      cluster.zones.length > 1
        ? `<strong>${cluster.zones.length} יישובים קרובים (מאוחד)</strong>`
        : `<strong>${cluster.leadZone.name}</strong>`;

    const circle = L.circle([cluster.centerLat, cluster.centerLng], {
      radius: cluster.radius,
      color,
      fillColor: color,
      fillOpacity: 0.35,
      weight: 2,
    });

    const popup = [
      popupHeader,
      `סוג: ${getAlertTypeLabel(cluster.leadZone.alertType)}`,
      `מצב: ${getStateLabel(cluster.leadZone.state)}`,
      `יישובים: ${preview}${more}`,
      instructions ? `הנחיות: ${instructions}` : null,
    ]
      .filter(Boolean)
      .join("<br/>");
    circle.bindPopup(popup);
    circle.addTo(state.markerLayer);
    createAlertTypeIconMarker(cluster, color).addTo(state.markerLayer);
  }
}

function renderAlertsList(historyEvents) {
  const container = document.getElementById("alertsList");
  container.innerHTML = "";

  if (!historyEvents || historyEvents.length === 0) {
    container.textContent = "אין התראות פעילות או אחרונות.";
    return;
  }

  const groups = buildHistoryGroups(historyEvents);

  for (const group of groups) {
    const item = document.createElement("article");
    item.className = `alert-item ${getHistoryItemClass(group)}`;

    const top = document.createElement("div");
    top.className = "alert-top";
    const title = document.createElement("strong");
    title.textContent = group.zone || `${group.cities.length} יישובים`;
    const stateBadge = document.createElement("span");
    stateBadge.textContent = getStateLabel(group.state);
    top.appendChild(title);
    top.appendChild(stateBadge);
    item.appendChild(top);

    const typeMeta = document.createElement("div");
    typeMeta.className = "meta";
    typeMeta.textContent = `סוג: ${getAlertTypeLabel(group.alertType)}`;
    item.appendChild(typeMeta);

    const timeMeta = document.createElement("div");
    timeMeta.className = "meta";
    timeMeta.textContent = `זמן: ${formatIso(group.timestamp)}`;
    item.appendChild(timeMeta);

    const instructionsMeta = document.createElement("div");
    instructionsMeta.className = "meta";
    instructionsMeta.textContent = `הנחיה: ${group.instructions || "-"}`;
    item.appendChild(instructionsMeta);

    if (group.cities.length <= MAX_VISIBLE_CITIES_IN_CARD) {
      const citiesMeta = document.createElement("div");
      citiesMeta.className = "meta";
      citiesMeta.textContent = `יישובים: ${group.cities.join(", ")}`;
      item.appendChild(citiesMeta);
    } else {
      const visible = group.cities.slice(0, MAX_VISIBLE_CITIES_IN_CARD);
      const hiddenCount = group.cities.length - visible.length;

      const shortLine = document.createElement("div");
      shortLine.className = "meta";
      shortLine.textContent = `יישובים: ${visible.join(", ")} ועוד ${hiddenCount}`;
      item.appendChild(shortLine);

      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "expand-btn";

      const allCities = document.createElement("div");
      allCities.className = "meta full-cities hidden";
      allCities.textContent = group.cities.join(", ");
      item.appendChild(allCities);

      const expanded = state.expandedHistoryGroups.has(group.key);
      allCities.classList.toggle("hidden", !expanded);
      expandBtn.textContent = expanded ? "הצג פחות" : "הצג עוד";
      expandBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const isOpen = state.expandedHistoryGroups.has(group.key);
        if (isOpen) {
          state.expandedHistoryGroups.delete(group.key);
        } else {
          state.expandedHistoryGroups.add(group.key);
        }
        renderAlertsList(historyEvents);
      });
      item.appendChild(expandBtn);
    }

    item.addEventListener("click", () => {
      if (!group.coordinates || group.coordinates.length === 0) return;
      if (group.coordinates.length === 1) {
        map.flyTo(group.coordinates[0], 10, { duration: 0.5 });
        return;
      }
      const bounds = L.latLngBounds(group.coordinates);
      map.fitBounds(bounds, { padding: [25, 25], maxZoom: 10 });
    });
    container.appendChild(item);
  }
}

function filterExpiredEndedZones(zones) {
  const now = Date.now();
  return zones.filter((zone) => {
    if (zone.state !== "ended") return true;
    const endedAt = new Date(zone.endedAt || 0).getTime();
    return endedAt > 0 && now - endedAt <= ENDED_TTL_MS;
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

function updateStatus(payload, visibleZones) {
  const el = document.getElementById("statusLine");
  const activeCount = visibleZones.filter((z) => z.state === "active").length;
  const historyCount = Array.isArray(payload.history) ? payload.history.length : 0;
  const apiError = payload.api && payload.api.error ? ` | שגיאת API: ${payload.api.error}` : "";
  const testModeText = state.testMode ? " | מצב בדיקה פעיל" : "";
  el.textContent = `עודכן: ${formatIso(payload.generatedAt)} | פעיל במפה: ${activeCount} | היסטוריה: ${historyCount}${apiError}${testModeText}`;
}

function renderApiConsole(payload) {
  if (!DEBUG_MODE) return;
  const output = document.getElementById("apiConsoleOutput");
  if (!output) return;

  const body = {
    generatedAt: payload.generatedAt || null,
    api: payload.api || null,
    alerts: Array.isArray(payload.alerts) ? payload.alerts : [],
  };
  output.textContent = JSON.stringify(body, null, 2);
}

function setApiConsoleVisible(visible) {
  if (!DEBUG_MODE) return;
  state.apiConsoleVisible = visible;
  const panel = document.getElementById("apiConsolePanel");
  const btn = document.getElementById("toggleApiConsoleBtn");
  if (!panel || !btn) return;
  panel.classList.toggle("hidden", !visible);
  btn.textContent = visible ? "הסתר" : "הצג";
}

function setupDebugUI() {
  const actions = document.getElementById("testActionsRow");
  const consoleCard = document.getElementById("apiConsoleCard");
  if (DEBUG_MODE) {
    if (actions) actions.classList.remove("hidden");
    if (consoleCard) consoleCard.classList.remove("hidden");
  } else {
    if (actions) actions.classList.add("hidden");
    if (consoleCard) consoleCard.classList.add("hidden");
  }
}

async function refresh() {
  try {
    const [lookupPayload, rawPayload] = await Promise.all([
      fetchJson("./data/zones-lookup.json"),
      fetchJson("./data/raw-alerts.json"),
    ]);
    state.zonesLookup = Array.isArray(lookupPayload.cities) ? lookupPayload.cities : [];

    // Build a fast lookup map from city name → entry
    const lookupByName = {};
    for (const city of state.zonesLookup) {
      if (city && city.normalizedName) lookupByName[city.normalizedName] = city;
    }

    // Merge raw API alerts with previous local state
    const previousState = loadAlertsState();
    const currentByName = pickCurrentZones(rawPayload.alerts || []);
    const mergedResult = mergeZoneStates(
      currentByName,
      previousState.zones || [],
      previousState.history || [],
      lookupByName
    );

    const alertsPayload = {
      generatedAt: rawPayload.generatedAt,
      api: rawPayload.api,
      alerts: rawPayload.alerts,
      zones: mergedResult.zones,
      history: mergedResult.history,
    };

    saveAlertsState({ zones: mergedResult.zones, history: mergedResult.history });
    state.alertsPayload = alertsPayload;

    const payloadToRender = state.testMode && state.testPayload ? state.testPayload : alertsPayload;
    const zones = filterExpiredEndedZones(Array.isArray(payloadToRender.zones) ? payloadToRender.zones : []);
    const historyEvents = Array.isArray(payloadToRender.history) ? payloadToRender.history : [];
    renderCityOptions();
    renderMarkers(zones);
    renderAlertsList(historyEvents);
    renderSelectedLocations(zones);
    updateStatus(payloadToRender, zones);
    renderApiConsole(payloadToRender);
    triggerLocationAlertsIfNeeded(zones);
  } catch (err) {
    document.getElementById("statusLine").textContent = `שגיאה בטעינת נתונים: ${err.message}`;
  }
}

function createTestPayload() {
  const now = new Date();
  const nowIso = now.toISOString();
  const candidates = state.zonesLookup.filter((c) => c && c.name && c.lat != null && c.lng != null);
  if (candidates.length < TEST_ALERT_TYPES.length) {
    return {
      generatedAt: nowIso,
      api: {
        source: "mock",
        error: `אין מספיק ערים עם קואורדינטות ליצירת תרחיש בדיקה (נדרשות לפחות ${TEST_ALERT_TYPES.length}).`,
      },
      alerts: [],
      zones: [],
      history: [],
      unresolvedZones: [],
    };
  }

  const selected = pickRandomUniqueCities(candidates, TEST_ALERT_TYPES.length);
  const scenario = TEST_ALERT_TYPES.map((type, idx) => ({
    type,
    instructions: `בדיקה: ${getAlertTypeLabel(type)}`,
    cities: [selected[idx]],
  }));

  const alerts = scenario.map((entry, idx) => ({
    id: `test-${entry.type}-${idx + 1}`,
    type: entry.type,
    cities: entry.cities.map((c) => c.name),
    instructions: entry.instructions,
  }));

  const zones = [];
  const history = [];
  for (const entry of scenario) {
    for (const city of entry.cities) {
      const zone = {
        name: city.name,
        normalizedName: normalizeName(city.name),
        alertType: entry.type,
        state: "active",
        alertId: `test-${entry.type}`,
        instructions: entry.instructions,
        startedAt: nowIso,
        endedAt: null,
        lastSeenAt: nowIso,
        lat: city.lat,
        lng: city.lng,
        zone: city.zone || null,
      };
      zones.push(zone);
      history.push({
        timestamp: nowIso,
        name: zone.name,
        normalizedName: zone.normalizedName,
        alertType: zone.alertType,
        state: zone.state,
        instructions: zone.instructions,
        lat: zone.lat,
        lng: zone.lng,
      });
    }
  }

  return {
    generatedAt: nowIso,
    endedTtlMs: ENDED_TTL_MS,
    api: { source: "mock-test-injection", error: null },
    alerts,
    zones,
    history,
    unresolvedZones: [],
  };
}

function pickRandomUniqueCities(candidates, count) {
  const copy = candidates.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy.slice(0, count);
}

function wireEvents() {
  document.getElementById("addLocationBtn").addEventListener("click", () => {
    const input = document.getElementById("locationInput");
    const value = normalizeName(input.value);
    if (!value) return;
    state.selectedLocations.add(value);
    input.value = "";
    saveSelectedLocations();
    ensureNotificationPermission();
    const zones = state.alertsPayload && Array.isArray(state.alertsPayload.zones) ? state.alertsPayload.zones : [];
    renderSelectedLocations(filterExpiredEndedZones(zones));
  });

  const soundToggle = document.getElementById("soundToggle");
  if (soundToggle) {
    soundToggle.addEventListener("change", () => {
      state.alertSettings.soundEnabled = !!soundToggle.checked;
      saveAlertSettings();
    });
  }

  const notificationToggle = document.getElementById("notificationToggle");
  if (notificationToggle) {
    notificationToggle.addEventListener("change", () => {
      state.alertSettings.notificationsEnabled = !!notificationToggle.checked;
      saveAlertSettings();
      if (state.alertSettings.notificationsEnabled) {
        ensureNotificationPermission();
      }
    });
  }

  const toggleBtn = document.getElementById("toggleApiConsoleBtn");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      setApiConsoleVisible(!state.apiConsoleVisible);
    });
  }

  const injectBtn = document.getElementById("injectTestAlertsBtn");
  if (injectBtn) {
    injectBtn.addEventListener("click", () => {
      state.testPayload = createTestPayload();
      state.testMode = true;
      refresh();
    });
  }

  const clearBtn = document.getElementById("clearTestAlertsBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      state.testMode = false;
      state.testPayload = null;
      refresh();
    });
  }
}

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function renderFileProtocolHint() {
  const status = document.getElementById("statusLine");
  status.textContent =
    "העמוד נפתח דרך file:// ולכן הדפדפן חוסם fetch ל-JSON. יש להריץ: npm run web ואז לפתוח http://localhost:8080";
  document.getElementById("alertsList").textContent = "יש להפעיל שרת מקומי כדי לטעון התראות.";
}

loadSelectedLocations();
loadAlertSettings();
setupDebugUI();
wireEvents();
syncAlertSettingsUI();
setApiConsoleVisible(false);
if (isFileProtocol()) {
  renderFileProtocolHint();
} else {
  refresh();
  setInterval(refresh, REFRESH_MS);
}
