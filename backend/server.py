"""
Pikud Ha'oref alert backend — Python/Flask replacement for server.js.
Polls the HFC API every 3 seconds, stores up to 1000 deduplicated records,
and exposes GET /api/alerts + GET /health.

Memory target: ~30-50 MB RSS (vs ~150 MB for Node).
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# State (written only by the poller thread, read by Flask)
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_state = {
    "live": [],
    "history": [],
    "last_poll_at": None,
    "last_error": None,
    "last_fp": None,
}


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
        HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False, indent=2))
    except Exception as exc:
        log.error("Could not save history: %s", exc)


# ---------------------------------------------------------------------------
# Fingerprint — same logic as the JS version
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
# Polling loop (runs in a daemon thread)
# ---------------------------------------------------------------------------
def _poll_loop() -> None:
    while True:
        try:
            alerts = pikud_haoref.get_active_alerts(timeout=10)
            now_iso = datetime.now(timezone.utc).isoformat()
            fp = _fingerprint(alerts)

            with _lock:
                _state["last_poll_at"] = now_iso
                _state["last_error"] = None
                _state["live"] = alerts

                if fp != _state["last_fp"] and alerts:
                    for a in alerts:
                        _state["history"].insert(0, {
                            "timestamp": now_iso,
                            "id": a.get("id"),
                            "type": a.get("type", "unknown"),
                            "instructions": a.get("instructions"),
                            "cities": a.get("cities", []),
                        })
                    if len(_state["history"]) > MAX_HISTORY:
                        _state["history"] = _state["history"][:MAX_HISTORY]
                    _save_history(_state["history"])
                    log.info("New alert batch: %d alert(s)", len(alerts))

                _state["last_fp"] = fp

        except Exception as exc:
            with _lock:
                _state["last_poll_at"] = datetime.now(timezone.utc).isoformat()
                _state["last_error"] = str(exc)
            log.warning("Poll error: %s", exc)

        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)


@app.get("/api/alerts")
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


@app.get("/api/about")
def api_about():
    import platform, sys
    with _lock:
        history_count = len(_state["history"])
        last_poll = _state["last_poll_at"]
        last_error = _state["last_error"]
    return jsonify({
        "name": "pikud-backend",
        "description": "Pikud Ha'oref real-time alert backend — Python/Flask port of pikud-haoref-api",
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


@app.get("/health")
def health():
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    _state["history"] = _load_history()

    poller = threading.Thread(target=_poll_loop, daemon=True, name="poller")
    poller.start()

    log.info("Listening on port %d", PORT)
    app.run(host="0.0.0.0", port=PORT, threaded=True)
