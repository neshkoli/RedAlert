"""
Pikud Ha'oref alert backend — Python/Flask.
Polls the HFC API every 3 seconds, stores up to 1000 deduplicated records,
and exposes GET /api/alerts + GET /health.

On every alert change, pushes a snapshot to the Cloudflare Worker's KV cache
(POST /push) so the frontend always has fresh data without direct IP access.

Memory target: ~30-50 MB RSS (vs ~150 MB for Node).
"""

import gc
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from flask import Flask, jsonify
from flask_cors import CORS

import pikud_haoref

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", 3000))
POLL_INTERVAL = 3          # seconds between polls
MAX_HISTORY = 1000
HISTORY_FILE = Path(__file__).parent / "history.json"

# Cloudflare Worker KV push endpoint — keeps the browser-facing Worker fresh.
CF_WORKER_PUSH_URL = os.environ.get(
    "CF_WORKER_PUSH_URL",
    "https://redalert-proxy.neshkoli.workers.dev/push",
)
CF_PUSH_SECRET = os.environ.get("CF_PUSH_SECRET", "810542d1bb74c57a0a4970abb2b23e07c4de69b5")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# State (written only by the poller thread, read by Flask workers)
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_state = {
    "live": [],
    "history": [],
    "last_poll_at": None,
    "last_error": None,
    "last_fp": None,
}
_poller_started = False
_poller_lock = threading.Lock()


# ---------------------------------------------------------------------------
# History persistence
# ---------------------------------------------------------------------------
def _load_history() -> list:
    try:
        if HISTORY_FILE.exists():
            data = json.loads(HISTORY_FILE.read_text())
            if isinstance(data, list):
                log.info("Loaded %d history records from disk", len(data))
                return data
    except Exception as exc:
        log.warning("Could not load history: %s", exc)
    return []


def _save_history(history: list) -> None:
    try:
        # Write without indent to save disk space and reduce serialization cost.
        HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False))
    except Exception as exc:
        log.error("Could not save history: %s", exc)


# ---------------------------------------------------------------------------
# Fingerprint
# ---------------------------------------------------------------------------
def _fingerprint(alerts: list) -> str:
    normalized = sorted(
        [
            {
                "id": a.get("id"),
                "type": a.get("type", "unknown"),
                "instructions": a.get("instructions"),
                "cities": sorted(a.get("cities", [])),
            }
            for a in alerts
        ],
        key=lambda x: f"{x['type']}|{x['id']}",
    )
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True)


# ---------------------------------------------------------------------------
# Polling loop (runs in a daemon thread, started once per process)
# ---------------------------------------------------------------------------
def _poll_loop() -> None:
    gc_counter = 0
    while True:
        should_push = False
        snapshot = None
        try:
            alerts = pikud_haoref.get_active_alerts(timeout=10)
            now_iso = datetime.now(timezone.utc).isoformat()
            fp = _fingerprint(alerts)

            with _lock:
                _state["last_poll_at"] = now_iso
                _state["last_error"] = None
                _state["live"] = alerts

                changed = fp != _state["last_fp"]
                if changed and alerts:
                    for a in alerts:
                        _state["history"].insert(0, {
                            "timestamp": now_iso,
                            "id": a.get("id"),
                            "type": a.get("type", "unknown"),
                            "instructions": a.get("instructions"),
                            "cities": a.get("cities", []),
                        })
                    if len(_state["history"]) > MAX_HISTORY:
                        # Trim to 90 % of max to avoid re-trimming on every insert.
                        _state["history"] = _state["history"][:int(MAX_HISTORY * 0.9)]
                    _save_history(_state["history"])
                    log.info("New alert batch: %d alert(s)", len(alerts))

                _state["last_fp"] = fp

                # Push to Cloudflare Worker KV on every change and every ~30s heartbeat.
                _state["push_counter"] = _state.get("push_counter", 0) + 1
                should_push = changed or (_state["push_counter"] % 10 == 0)
                if should_push:
                    snapshot = {
                        "ok": True,
                        "generatedAt": now_iso,
                        "lastPollAt": now_iso,
                        "error": None,
                        "live": list(_state["live"]),
                        "history": list(_state["history"]),
                    }

        except Exception as exc:
            with _lock:
                _state["last_poll_at"] = datetime.now(timezone.utc).isoformat()
                _state["last_error"] = str(exc)
            log.warning("Poll error: %s", exc)

        if should_push and snapshot:
            threading.Thread(target=_push_to_kv, args=(snapshot,), daemon=True).start()

        # Run the GC every ~5 minutes to reclaim memory from push thread cycles.
        gc_counter += 1
        if gc_counter % 100 == 0:
            gc.collect()

        time.sleep(POLL_INTERVAL)


def _ensure_poller() -> None:
    """Start the poller thread exactly once per process."""
    global _poller_started
    with _poller_lock:
        if _poller_started:
            return
        _state["history"] = _load_history()
        t = threading.Thread(target=_poll_loop, daemon=True, name="poller")
        t.start()
        _poller_started = True
        log.info("Poller thread started (pid=%d)", os.getpid())


# ---------------------------------------------------------------------------
# KV push — sends the current snapshot to the Cloudflare Worker KV cache
# ---------------------------------------------------------------------------
def _push_to_kv(snapshot: dict) -> None:
    """Fire-and-forget POST to the Worker /push endpoint."""
    if not CF_WORKER_PUSH_URL or not CF_PUSH_SECRET:
        return
    try:
        resp = requests.post(
            CF_WORKER_PUSH_URL,
            data=json.dumps(snapshot, ensure_ascii=False),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {CF_PUSH_SECRET}",
            },
            timeout=5,
            verify=False,
        )
        if resp.status_code != 200:
            log.warning("KV push failed: HTTP %d", resp.status_code)
    except Exception as exc:
        log.warning("KV push error: %s", exc)

# ---------------------------------------------------------------------------
# Flask app factory
# ---------------------------------------------------------------------------
def create_app() -> Flask:
    """Create and configure the Flask application."""
    _ensure_poller()
    flask_app = Flask(__name__)
    flask_app.json.ensure_ascii = False
    CORS(flask_app)
    _register_routes(flask_app)
    return flask_app


def _register_routes(flask_app: Flask) -> None:
    @flask_app.get("/api/alerts")
    def api_alerts():
        with _lock:
            snap = {
                "ok": True,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "lastPollAt": _state["last_poll_at"],
                "error": _state["last_error"],
                "live": _state["live"],
                "history": _state["history"],
            }
        return jsonify(snap)

    @flask_app.get("/api/about")
    def api_about():
        import platform, sys
        with _lock:
            history_count = len(_state["history"])
            last_poll = _state["last_poll_at"]
            last_error = _state["last_error"]
        return jsonify({
            "name": "pikud-backend",
            "description": "Pikud Ha'oref real-time alert backend — Python/Flask",
            "version": "1.0.0",
            "source": "https://github.com/neshkoli/RedAlert",
            "runtime": {
                "python": sys.version,
                "platform": platform.platform(),
            },
            "config": {
                "pollIntervalSeconds": POLL_INTERVAL,
                "maxHistory": MAX_HISTORY,
                "port": PORT,
            },
            "status": {
                "lastPollAt": last_poll,
                "lastError": last_error,
                "historyRecords": history_count,
            },
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        })

    @flask_app.get("/health")
    def health():
        return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Direct run (dev only)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app = create_app()
    log.info("Listening on port %d (Flask dev server)", PORT)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
