const fs = require("fs");
const path = require("path");
const pikudHaoref = require("pikud-haoref-api");

// In CI: checked out as main/ with sibling data/ directory
// Locally: run from repo root, push to data branch via git
const CI = !!process.env.CI;
const OUTPUT = CI
  ? path.join(__dirname, "..", "..", "data", "raw-alerts.json")
  : path.join(__dirname, "..", "public", "data", "raw-alerts.json");

pikudHaoref.getActiveAlerts((err, alerts) => {
  const payload = {
    generatedAt: new Date().toISOString(),
    api: {
      source: "pikud-haoref-api",
      error: err ? err.message : null,
    },
    alerts: err ? [] : (Array.isArray(alerts) ? alerts : []),
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUTPUT} | alerts: ${payload.alerts.length} | error: ${payload.api.error || "none"}`);
}, { timeout: 10000 });
