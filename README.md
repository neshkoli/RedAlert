# RedAlert — מפת התראות פיקוד העורף

Real-time map of Home Front Command (Pikud Ha'oref) alerts for Israel.  
Live site: **https://neshkoli.github.io/RedAlert/**

---

## Architecture Overview

```
oref.org.il
    │
    ▼  (every 3 seconds)
OCI Backend — Python/Flask (Jerusalem region)
    │  poll → deduplicate → history.json
    │
    │  on change + every ~30s heartbeat
    ▼
Cloudflare Workers KV  ←─── POST /push (PUSH_SECRET auth)
    │
    │  on every browser request (~0ms read)
    ▼
Cloudflare Worker  ──►  browser (GitHub Pages)
                        https://neshkoli.github.io/RedAlert/
```

### Components

| Layer | Technology | Location | Purpose |
|---|---|---|---|
| **Frontend** | Vanilla JS + Leaflet | `public/` → GitHub Pages | Map + alerts panel UI |
| **Backend** | Python 3 / Flask | `backend/` → OCI instance | Poll HFC API every 3 s, push to KV |
| **KV cache** | Cloudflare Workers KV | `ALERTS_CACHE` namespace | Decouple browser from OCI; ~0ms read |
| **HTTPS gateway** | Cloudflare Worker | `worker/` → workers.dev | Serve KV data over HTTPS to browser |
| **CI — frontend** | GitHub Actions | `.github/workflows/deploy-pages.yml` | Build + deploy `public/` to GitHub Pages on push |
| **CI — backend** | GitHub Actions | `.github/workflows/deploy-oci.yml` | Deploy `backend/` to OCI on push |

---

## Data Flow

```
Every 3 seconds (OCI backend):
  pikud_haoref.py ──► GET oref.org.il ──► deduplicate
      │
      ├─ store in memory + history.json (≤ 1000 records)
      │
      └─ if changed (or every ~30s heartbeat):
             POST https://redalert-proxy.neshkoli.workers.dev/push
                  Authorization: Bearer <PUSH_SECRET>
                  body: { ok, generatedAt, lastPollAt, live, history }
                       ──► Cloudflare Worker writes to KV key "latest" (TTL 120s)

Every 5 seconds (browser):
  app.js ──► GET https://redalert-proxy.neshkoli.workers.dev
                  Cloudflare Worker reads KV "latest" ──► response to browser
```

**Why Workers KV instead of direct access to the OCI backend:**

Cloudflare Workers cannot `fetch()` bare IP addresses (returns 403), and accepting self-signed TLS certificates requires a paid Advanced Certificate Manager plan. The push model via KV is free, gives ~0 ms read latency, and decouples the browser entirely from OCI availability.

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
| `server.py` | Flask app — poller thread + KV push + REST endpoints |
| `pikud_haoref.py` | Python port of `pikud-haoref-api` (fetches & parses HFC alert feed) |
| `requirements.txt` | `flask`, `flask-cors`, `requests`, `waitress` |
| `history.json` | Persistent alert history (survives restarts) |

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/alerts` | `{ ok, generatedAt, lastPollAt, live, history }` |
| `GET` | `/api/about` | Runtime info, config, current status |
| `GET` | `/health` | `{ ok: true }` — used by CI health check |

### KV push logic

On each poll cycle the backend checks whether the alert fingerprint changed. If it changed (or every ~30 s as a keepalive), it fires a background thread that `POST`s the full snapshot to the Worker's `/push` endpoint with a `Bearer <PUSH_SECRET>` header. The Worker writes it to KV with a 120-second TTL so stale data auto-expires if the backend goes offline.

### OCI setup (systemd)

The backend runs as a `systemd` service `pikud-backend` under the `opc` user, with a Python virtual env at `/opt/pikud-venv`, served by Waitress WSGI (`python wsgi.py`).

---

## Cloudflare Worker (`worker/`)

| File | Role |
|---|---|
| `index.js` | Worker — serves KV data (`GET /`) and receives backend pushes (`POST /push`) |
| `wrangler.toml` | Wrangler config — KV namespace binding (`ALERTS_CACHE`) |

### Worker endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Read `latest` from KV, annotate with `stale` flag if age > 30 s |
| `POST` | `/push` | Write snapshot to KV — requires `Authorization: Bearer <PUSH_SECRET>` |
| `OPTIONS` | `*` | CORS preflight |

### Bindings & secrets

| Name | Type | Purpose |
|---|---|---|
| `ALERTS_CACHE` | KV Namespace | Stores the latest alert snapshot |
| `PUSH_SECRET` | Secret | Shared token between OCI backend and Worker |

---

## CI / CD (`.github/workflows/`)

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

### Worker (local preview)

```bash
cd worker
npx wrangler dev   # local Worker preview with real KV
```

### CLI monitor (logs alerts to file)

```bash
npm start
# writes JSON lines to logs/pikud_log_YYYY-MM-DD.json
```

---

## Notes

- The HFC API (`oref.org.il`) is reachable only from Israeli IP addresses. The OCI instance is in the **Israel Central (Jerusalem)** region, ensuring the backend always has a local Israeli IP.
- City geolocation data comes from the `pikud-haoref-api` npm package's `cities.json` archive, matched at build time.
- Legacy Node/data-branch polling code was removed; the single live source is OCI backend → Worker KV.
