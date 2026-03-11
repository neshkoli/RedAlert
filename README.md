# RedAlert — מפת התראות פיקוד העורף

Real-time map of Home Front Command (Pikud Ha'oref) alerts for Israel.  
Live site: **https://neshkoli.github.io/RedAlert/**

---

## Architecture Overview

```
api.tzevaadom.co.il
    │
    ▼
Cloudflare Worker (adapter)
    │  fetch/normalize → { ok, generatedAt, lastPollAt, live, history, api }
    ▼
browser (GitHub Pages)
https://neshkoli.github.io/RedAlert/
```

### Components

| Layer | Technology | Location | Purpose |
|---|---|---|---|
| **Frontend** | Vanilla JS + Leaflet | `public/` → GitHub Pages | Map + alerts panel UI |
| **HTTPS gateway + adapter** | Cloudflare Worker | `worker/` → workers.dev | Fetch TzevaAdom APIs, normalize payload for frontend |
| **CI — frontend** | GitHub Actions | `.github/workflows/deploy-pages.yml` | Build + deploy `public/` to GitHub Pages on push |

---

## Data Flow

```
Every 5 seconds (browser):
  app.js ──► GET https://redalert-proxy.neshkoli.workers.dev
               Worker:
                 1) GET https://api.tzevaadom.co.il/notifications?   (primary)
                 2) GET https://api.tzevaadom.co.il/alerts-history/? (history/fallback)
                 3) map threat/isDrill -> type/instructions and return stable payload
```

---

## Frontend (`public/`)

| File | Role |
|---|---|
| `index.html` | App shell — two-panel layout (map + alerts) |
| `app.js` | All client logic: polling, state, map rendering, UI |
| `styles.css` | Dark-theme responsive styles |
| `data/zones-lookup.json` | City → lat/lng lookup (built at deploy time from `pikud-haoref-api`) |

### Key frontend behaviors

- **Polling** — fetches the Cloudflare Worker every **5 seconds**
- **Alert state machine** — tracks `active → ended → expired` transitions per city in `localStorage`
- **Map circles** — active alerts: red; news/early-warning: orange; ended: green (shown for 1 minute)
- **History panel** — deduplicates `active` + `ended` events for the same alert into one card
- **Hold-to-preview** — press and hold any history card for 400 ms to isolate that group's circles on the map; release to return to live view
- **Location watch** — add cities to get sound + desktop notification when they are under alert
- **Expired filter** — alerts with state `"פג תוקף"` are hidden from the panel

### Alert colors

| Color | Meaning |
|---|---|
| 🔴 Red | Active alert (missiles, infiltration, etc.) |
| 🟠 Orange | News flash / early warning |
| 🟢 Green | Event ended (shown for 60 s, then cleared) |

---

## Legacy backend (`backend/`)

The previous OCI Python backend has been retired from production.
`backend/` remains in the repository only as legacy/reference code and is not part of the active runtime path.

---

## Cloudflare Worker (`worker/`)

| File | Role |
|---|---|
| `index.js` | Worker — fetches TzevaAdom APIs, normalizes data, serves browser contract |
| `wrangler.toml` | Wrangler config |

### Worker endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Return normalized live + history payload consumed by frontend |
| `OPTIONS` | `*` | CORS preflight |

---

## CI / CD (`.github/workflows/`)

### `deploy-pages.yml` — runs on push to `main`
1. Installs Node dependencies
2. Runs `npm run build:data` → generates `public/data/zones-lookup.json`
3. Deploys `public/` to GitHub Pages

---

## Local Development

### Frontend only

```bash
npm install
npm run build:data   # generates public/data/zones-lookup.json
npm run web          # static file server on http://localhost:8080
```

### Worker (local preview)

```bash
cd worker
npx wrangler dev
```

### CLI monitor (logs alerts to file)

```bash
npm start
# writes JSON lines to logs/pikud_log_YYYY-MM-DD.json
```

---

## Notes

- Production depends on TzevaAdom upstream endpoints:
  - `https://api.tzevaadom.co.il/notifications?`
  - `https://api.tzevaadom.co.il/alerts-history/?`
- Degraded mode: if upstream fetch fails, the worker returns `{ ok: false, error, live: [], history: [] }` so the frontend can fail gracefully.
- City geolocation data comes from the `pikud-haoref-api` npm package's `cities.json` archive, matched at build time.

## Rollout checklist (worker-only)

1. Deploy `worker/` changes to Cloudflare Workers.
2. Verify `GET /` returns `{ ok, generatedAt, lastPollAt, live, history, api }`.
3. Deploy frontend (`deploy-pages.yml`) and verify map + history rendering.
4. Monitor for at least 24 hours (empty `live` spikes, upstream errors in `api.error`).
5. Decommission OCI runtime and remove its secrets/infrastructure.
