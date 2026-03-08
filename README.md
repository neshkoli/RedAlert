# Pikud Alerts Web + CLI

This project now includes:

- A CLI monitor (`pikud.js`) that logs active alerts.
- A static website (`public/`) with two panels:
  - Left: Israel map (Leaflet + OpenStreetMap) with colored circles
  - Right: alerts list + location selection
- A data builder script that generates static JSON for the site.

The API source is `pikud-haoref-api` installed from GitHub (`v5` style API with `getActiveAlerts`).

## Alert Colors on Map

- Red: active alert (e.g. missiles and other active types)
- Orange: `newsFlash` / `earlyWarning`
- Green: ended event, shown for 1 minute and then cleared

## Install

```bash
npm install
```

## Quick API Smoke Test

```bash
npm run test:api
```

This prints exported methods and a sample `getActiveAlerts` response.

## Build Static Data

```bash
npm run build:data
```

This generates:

- `public/data/zones-lookup.json` from `pikud-haoref-api/cities.json`
- `public/data/active-alerts.json` from live alert polling

Optional proxy (outside Israel):

```bash
PIKUD_PROXY_URL="http://user:pass@host:port" npm run build:data
```

## Run Website

```bash
npm run web
```

Then open `http://localhost:8080`.

`npm run web` now auto-refreshes API data every 5 seconds and updates static JSON automatically.  
The frontend reloads JSON every 5 seconds.

Manual mode (single build + static server, no background refresh):

```bash
npm run web:manual
```

## CLI Monitor (legacy + useful for logs)

```bash
npm start
```

Writes JSON lines to `logs/pikud_log_YYYY-MM-DD.json`.

## Notes

- The upstream API is typically reachable only from Israel unless using a proxy.
- City geolocation comes from the library city metadata archive and lookup matching.
