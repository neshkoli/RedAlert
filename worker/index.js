// Cloudflare Worker — HTTPS gateway for pikud-haoref alerts.
//
// Fetches from the GitHub data branch (updated every minute by GitHub Actions)
// which uses GitHub's own IP range — always reachable, no CORS issues.
// Reshapes the response to { ok, live, history, generatedAt, lastPollAt }
// so the frontend works identically whether using this Worker or the OCI backend.

const GITHUB_RAW =
  "https://raw.githubusercontent.com/neshkoli/RedAlert/data/raw-alerts.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const now = new Date().toISOString();
    try {
      // Bust GitHub's CDN cache with a timestamp query param
      const res = await fetch(`${GITHUB_RAW}?_=${Date.now()}`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);

      const data = await res.json();

      // data shape from fetch-alerts-ci.js: { generatedAt, api: { source, error }, alerts: [...] }
      // Reshape to backend shape: { ok, generatedAt, lastPollAt, api, live, history }
      const body = JSON.stringify({
        ok: true,
        generatedAt: now,
        lastPollAt: data.generatedAt || now,   // when GitHub Actions last polled
        api: data.api || { source: "github-data-branch", error: null },
        live: Array.isArray(data.alerts) ? data.alerts : [],
        history: [],
      });
      return new Response(body, { status: 200, headers: CORS_HEADERS });
    } catch (err) {
      const body = JSON.stringify({
        ok: false,
        generatedAt: now,
        lastPollAt: null,
        api: { source: "github-data-branch", error: err.message },
        live: [],
        history: [],
      });
      return new Response(body, { status: 200, headers: CORS_HEADERS });
    }
  },
};
