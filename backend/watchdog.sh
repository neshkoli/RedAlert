#!/usr/bin/env bash
# Watchdog for pikud-backend.
# Runs every minute via cron. Checks:
#   1. Health endpoint responds within 5s.
#   2. Backend RSS memory stays below MEMORY_LIMIT_MB.
# If either check fails → restart the service.
# If the OS itself is low on free RAM → sync & drop caches.

set -euo pipefail

SERVICE="pikud-backend"
HEALTH_URL="http://localhost:3000/health"
MEMORY_LIMIT_MB=150      # restart if RSS exceeds this
LOW_RAM_MB=100           # drop caches when free RAM falls below this
LOG_TAG="pikud-watchdog"

log() { logger -t "$LOG_TAG" "$*"; }

# ── 1. Health check ──────────────────────────────────────────────────────────
if ! curl -sf --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
    log "Health check failed — restarting $SERVICE"
    sudo systemctl restart "$SERVICE"
    exit 0
fi

# ── 2. Memory check ─────────────────────────────────────────────────────────
PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
if [[ -n "$PID" && "$PID" != "0" && -f "/proc/$PID/status" ]]; then
    RSS_KB=$(awk '/^VmRSS:/{print $2}' "/proc/$PID/status" 2>/dev/null || echo 0)
    RSS_MB=$(( RSS_KB / 1024 ))
    if (( RSS_MB > MEMORY_LIMIT_MB )); then
        log "Memory too high: ${RSS_MB}MB > ${MEMORY_LIMIT_MB}MB — restarting $SERVICE"
        sudo systemctl restart "$SERVICE"
        exit 0
    fi
fi

# ── 3. System-wide low RAM: drop page cache ──────────────────────────────────
FREE_MB=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 999)
if (( FREE_MB < LOW_RAM_MB )); then
    log "Low RAM: ${FREE_MB}MB available — dropping page cache"
    sync
    echo 1 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1 || true
fi
