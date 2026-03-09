#!/usr/bin/env node
/**
 * push-alerts.js
 * Fetches live alerts from oref.org.il and pushes raw-alerts.json
 * to the 'data' branch on GitHub. Run this on a local cron every minute.
 *
 * Usage:  node scripts/push-alerts.js
 * Cron:   * * * * * cd /Users/noame/dev/pikud && node scripts/push-alerts.js >> /tmp/push-alerts.log 2>&1
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const pikudHaoref = require("pikud-haoref-api");

const REPO_ROOT = path.join(__dirname, "..");
const TMP_FILE = path.join(REPO_ROOT, "public", "data", "raw-alerts.json");

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

pikudHaoref.getActiveAlerts((err, alerts) => {
  const payload = {
    generatedAt: new Date().toISOString(),
    api: {
      source: "pikud-haoref-api",
      error: err ? err.message : null,
    },
    alerts: err ? [] : (Array.isArray(alerts) ? alerts : []),
  };

  fs.mkdirSync(path.dirname(TMP_FILE), { recursive: true });
  fs.writeFileSync(TMP_FILE, JSON.stringify(payload, null, 2), "utf8");
  log(`Fetched: alerts=${payload.alerts.length} error=${payload.api.error || "none"}`);

  try {
    // Use a worktree or direct push via git
    const tmpDir = path.join(REPO_ROOT, ".data-worktree");
    if (!fs.existsSync(tmpDir)) {
      execSync(`git worktree add ${tmpDir} data`, { cwd: REPO_ROOT, stdio: "pipe" });
      log("Created worktree for data branch");
    }
    fs.writeFileSync(path.join(tmpDir, "raw-alerts.json"), JSON.stringify(payload, null, 2), "utf8");
    // Sync with remote before committing
    execSync(`git fetch origin data && git reset --hard origin/data`, { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "raw-alerts.json"), JSON.stringify(payload, null, 2), "utf8");
    execSync(`git add raw-alerts.json`, { cwd: tmpDir, stdio: "pipe" });
    const diff = execSync(`git diff --cached --stat`, { cwd: tmpDir }).toString().trim();
    if (!diff) {
      log("No changes to push");
      return;
    }
    execSync(`git commit -m "chore: update alert data [skip ci]"`, { cwd: tmpDir, stdio: "pipe" });
    execSync(`git push origin data`, { cwd: tmpDir, stdio: "pipe" });
    log("Pushed to data branch");
  } catch (pushErr) {
    log(`Push error: ${pushErr.message}`);
  }
}, { timeout: 10000 });
