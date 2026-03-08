const pikudHaoref = require("pikud-haoref-api");

function testGetActiveAlerts() {
  return new Promise((resolve, reject) => {
    pikudHaoref.getActiveAlerts((err, alerts) => {
      if (err) return reject(err);
      resolve(alerts);
    }, { timeout: 10000 });
  });
}

async function main() {
  console.log("Methods:", Object.keys(pikudHaoref));
  const alerts = await testGetActiveAlerts();
  console.log("getActiveAlerts result type:", Array.isArray(alerts) ? "array" : typeof alerts);
  console.log("getActiveAlerts length:", Array.isArray(alerts) ? alerts.length : 0);
  if (Array.isArray(alerts) && alerts.length > 0) {
    console.log("first alert:", JSON.stringify(alerts[0], null, 2));
  }
}

main().catch((err) => {
  console.error("API test failed:", err.message || err);
  process.exit(1);
});
