# RedAlert — מפת התראות פיקוד העורף

Real-time map of Home Front Command (Pikud Ha'oref) alerts for Israel.  
Live site: **https://neshkoli.github.io/RedAlert/**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Data Sources                                  │
│                                                                     │
│   oref.org.il  ──►  OCI Backend (Python/Flask)  ──►  history.json  │
│   oref.org.il  ──►  GitHub Actions (every 1 min) ──► data branch   │
└─────────────────────────────────────────────────────────────────────┘
                              │                           │
                              │                           ▼
                              │              Cloudflare Worker
                              │              (HTTPS proxy / reshaper)
                              │                           │
                              └───────────────────────────┘
                                                          │
                                                          ▼
                                           GitHub Pages (frontend)
                                           https://neshkoli.github.io/RedAlert/
```

### Components

| Layer | Technology | Location | Purpose |
|---|---|---|---|
| **Frontend** | Vanilla JS + Leaflet | `public/` → GitHub Pages | Map + alerts panel UI |
| **Backend** | Python 3 / Flask | `backend/` → OCI instance | Poll HFC API every 3 s, keep history |
| **HTTPS Proxy** | Cloudflare Worker | `worker/` → workers.dev | Serve data over HTTPS (mixed-content fix) |
| **CI — data** | GitHub Actions | `.github/workflows/update-alerts.yml` | Fetch live alerts every minute → `data` branch |
| **CI — frontend** | GitHub Actions | `.github/workflows/deploy-pages.yml` | Build + deploy `public/` to GitHub Pages on push |
| **CI — backend** | GitHub Actions | `.github/workflows/deploy-oci.yml` | Deploy `backend/` to OCI on push |

---

## Data Flow

```
Every 3 seconds:
  OCI Flask server
    └─ pikud_haoref.py  ──►  GET oref.org.il  ──►  deduplicate  ──►  history.json (≤1000 records)

Every 1 minute (GitHub Actions):
  scripts/fetch-alerts-ci.js  ──►  GET oref.org.il  ──►  raw-alerts.json  ──►  push to `data` branch

Every 5 seconds (browser):
  app.js  ──►  GET https://redalert-proxy.neshkoli.workers.dev
                   │
                   └─ Cloudflare Worker  ──►  GET raw.githubusercontent.com/…/data/raw-alerts.json
                                              (reshapes to { ok, live, history, generatedAt, lastPollAt })
```

The Cloudflare Worker is the single HTTPS endpoint the browser talks to.  
It reads from the GitHub `data` branch (updated by CI), which avoids mixed-content browser errors and Cloudflare's restriction on outbound HTTP to arbitrary IPs.

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

## Backend (`backend/`)

Python 3 / Flask application running on an **Oracle Cloud Infrastructure** free-tier instance in Jerusalem (1 OCPU, 1 GB RAM).

Chosen over Node.js because it runs at ~30–50 MB RSS vs ~150 MB for Node.

| File | Role |
|---|---|
| `server.py` | Flask app — poller thread + REST endpoints |
| `pikud_haoref.py` | Python port of `pikud-haoref-api` (fetches & parses HFC alert feed) |
| `requirements.txt` | `flask`, `flask-cors`, `requests`, `gunicorn` |
| `history.json` | Persistent alert history (survives restarts) |

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/alerts` | `{ ok, generatedAt, lastPollAt, live, history }` |
| `GET` | `/api/about` | Runtime info, config, current status |
| `GET` | `/health` | `{ ok: true }` — used by CI health check |

### OCI setup (systemd)

The backend runs as a systemd service `pikud-backend` managed by `opc` user with a Python virtual env at `/opt/pikud-venv`.

---

## Cloudflare Worker (`worker/`)

| File | Role |
|---|---|
| `index.js` | Worker fetch handler |
| `wrangler.toml` | Wrangler deployment config |

**Why a Worker?**  
GitHub Pages is served over HTTPS. The OCI backend runs plain HTTP on port 3000. Browsers block mixed-content requests, and Cloudflare Workers cannot reach arbitrary non-standard HTTP ports either. The solution: a Worker that reads `raw-alerts.json` from the repository's `data` branch (always HTTPS, always reachable from Cloudflare) and reshapes it to the same JSON schema the frontend expects.

---

## CI / CD (`.github/workflows/`)

### `update-alerts.yml` — runs every minute
1. Checks out `main` (for the build script) and `data` branch side-by-side
2. Runs `scripts/fetch-alerts-ci.js` → writes `raw-alerts.json`
3. Commits and pushes to the `data` branch (`[skip ci]`)

### `deploy-pages.yml` — runs on push to `main`
1. Installs Node dependencies
2. Runs `npm run build:data` → generates `public/data/zones-lookup.json`
3. Deploys `public/` to GitHub Pages

### `deploy-oci.yml` — runs on push to `main` when `backend/` files change
1. Writes the SSH deploy key from `OCI_SSH_KEY` secret
2. `scp` copies `server.py` + `pikud_haoref.py` to `/home/opc/pikud-backend/`
3. Optionally re-installs Python deps if `requirements.txt` changed
4. `ssh sudo systemctl restart pikud-backend`
5. Health checks `GET /health` — fails the workflow if backend is unresponsive

### Required GitHub Secrets

| Secret | Value |
|---|---|
| `OCI_SSH_KEY` | Private SSH key for the OCI instance |
| `OCI_HOST` | Public IP of the OCI instance |

---

## Local Development

### Frontend only

```bash
npm install
npm run build:data   # generates public/data/zones-lookup.json
npm run web          # static file server on http://localhost:8080
```

### Backend only

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
# → http://localhost:3000/api/alerts
```

### CLI monitor (logs alerts to file)

```bash
npm start
# writes JSON lines to logs/pikud_log_YYYY-MM-DD.json
```

---

## Notes

- The HFC API (`oref.org.il`) is reachable only from Israeli IP addresses in most cases.  
  GitHub Actions runners use global IPs — the `update-alerts.yml` workflow still works because GitHub's outbound IP range is whitelisted by the HFC CDN.
- The OCI instance is in the **Israel Central (Jerusalem)** region, ensuring the backend always has a local Israeli IP.
- City geolocation data comes from the `pikud-haoref-api` npm package's `cities.json` archive, matched at build time.
