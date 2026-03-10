// Cloudflare Worker — HTTPS gateway to the OCI Flask backend via KV cache.
//
// The OCI backend (Python/Flask, polling oref.org.il every 3s) pushes its
// latest alert snapshot to Cloudflare Workers KV on every change.
// This Worker reads from KV and serves it to the browser over HTTPS.
//
// Why KV instead of fetching the OCI backend directly:
//   Cloudflare Workers cannot fetch bare IP addresses (returns 403).
//   Workers also cannot fetch self-signed TLS certs without ACM (paid).
//   KV is free, ~0ms latency, and decoupled from OCI uptime.

const KV_KEY = "latest";
const MAX_KV_AGE_MS = 30 * 1000; // treat data as stale after 30s

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const now = new Date().toISOString();

    // POST /push  — called by the OCI backend to update the KV cache.
    // Protected by a shared secret in the Authorization header.
    const url = new URL(request.url);
    if (url.pathname === "/push" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.PUSH_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const body = await request.text();
      await env.ALERTS_CACHE.put(KV_KEY, body, { expirationTtl: 120 });
      return new Response("ok", { status: 200 });
    }

    // GET /  — serve cached alerts.
    try {
      const cached = await env.ALERTS_CACHE.get(KV_KEY);
      if (!cached) {
        return new Response(
          JSON.stringify({
            ok: false,
            generatedAt: now,
            lastPollAt: null,
            api: { source: "oci-backend", error: "no data in cache yet" },
            live: [],
            history: [],
          }),
          { status: 200, headers: CORS_HEADERS }
        );
      }

      const data = JSON.parse(cached);

      // Annotate with a flag if the backend hasn't pushed for a while.
      const pushedAt = data.generatedAt || data.lastPollAt || null;
      const ageMs = pushedAt ? Date.now() - new Date(pushedAt).getTime() : Infinity;
      if (ageMs > MAX_KV_AGE_MS) {
        data.api = data.api || {};
        data.api.stale = true;
        data.api.ageMs = ageMs;
      }

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          ok: false,
          generatedAt: now,
          lastPollAt: null,
          api: { source: "oci-backend", error: err.message },
          live: [],
          history: [],
        }),
        { status: 200, headers: CORS_HEADERS }
      );
    }
  },
};
