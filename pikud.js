var pikudHaoref = require("pikud-haoref-api");
var fs = require("fs");
var path = require("path");

var logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

var logFileName = "pikud_log_" + new Date().toISOString().split("T")[0] + ".json";
var logFilePath = path.join(logsDir, logFileName);
var interval = 10000;
var lastFingerprint = null;
var lastProcessTime = 0;

function writeLog(data) {
  var logEntry = {
    timestamp: new Date().toISOString(),
    localTime: new Date().toLocaleString(),
    data: data,
  };

  fs.appendFile(logFilePath, JSON.stringify(logEntry) + "\n", function (err) {
    if (err) {
      console.error("שגיאה בכתיבה לקובץ לוג:", err);
    }
  });
}

function fingerprintAlerts(alerts) {
  var normalized = (alerts || []).map(function (a) {
    var cities = Array.isArray(a.cities) ? a.cities.slice().sort() : [];
    return {
      id: a.id || null,
      type: a.type || "unknown",
      instructions: a.instructions || null,
      cities: cities,
    };
  });
  normalized.sort(function (a, b) {
    var left = (a.type || "") + "|" + (a.id || "") + "|" + a.cities.join(",");
    var right = (b.type || "") + "|" + (b.id || "") + "|" + b.cities.join(",");
    return left.localeCompare(right);
  });
  return JSON.stringify(normalized);
}

function shouldProcess(alerts, err) {
  if (err) return true;
  var current = fingerprintAlerts(alerts);
  var now = Date.now();
  var changed = current !== lastFingerprint;
  var stale = now - lastProcessTime >= 120000;
  return changed || stale;
}

function poll() {
  var options = { timeout: 10000 };

  pikudHaoref.getActiveAlerts(function (err, alerts) {
    setTimeout(poll, interval);

    if (!shouldProcess(alerts, err)) return;

    lastProcessTime = Date.now();
    lastFingerprint = fingerprintAlerts(alerts || []);

    writeLog({
      rawApiResponse: alerts || [],
      processedData: {
        success: !err,
        error: err ? err.message || String(err) : null,
        alerts: alerts || [],
        alertsCount: Array.isArray(alerts) ? alerts.length : 0,
      },
      apiError: err || null,
    });

    if (err) {
      console.log("שליפת ההתראות נכשלה:", err.message || err);
      return;
    }

    var hasAlerts = Array.isArray(alerts) && alerts.length > 0;
    if (!hasAlerts) return;

    console.log(new Date().toLocaleString());
    console.log("התראות פעילות כרגע:");
    console.log(
      alerts.map(function (a) {
        return {
          type: a.type,
          id: a.id || null,
          citiesCount: Array.isArray(a.cities) ? a.cities.length : 0,
          cities: a.cities || [],
          instructions: a.instructions || null,
        };
      })
    );
  }, options);
}

console.log("ניטור פיקוד העורף הופעל בתאריך", new Date().toLocaleString("he-IL"));
console.log("קובץ לוג:", logFilePath);
writeLog({ event: "application_started", interval: interval, apiMethod: "getActiveAlerts" });
poll();
