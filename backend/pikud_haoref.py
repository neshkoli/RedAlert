"""
Python port of pikud-haoref-api (github:eladnava/pikud-haoref-api).
Fetches active alerts from the Israeli Home Front Command (Pikud Ha'oref) API.
"""

import time
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

ALERTS_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json"
HISTORY_URL = "https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json"

_HEADERS = {
    "Pragma": "no-cache",
    "Cache-Control": "max-age=0",
    "Referer": "https://www.oref.org.il/11226-he/pakar.aspx",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/75.0.3770.100 Safari/537.36"
    ),
}

# category -> alert type (Alerts.json)
_CATEGORY_MAP = {
    1: "missiles",
    2: "general",
    3: "earthQuake",
    4: "radiologicalEvent",
    5: "tsunami",
    6: "hostileAircraftIntrusion",
    7: "hazardousMaterials",
    10: "newsFlash",
    13: "terroristInfiltration",
    101: "missilesDrill",
    102: "generalDrill",
    103: "earthQuakeDrill",
    104: "radiologicalEventDrill",
    105: "tsunamiDrill",
    106: "hostileAircraftIntrusionDrill",
    107: "hazardousMaterialsDrill",
    113: "terroristInfiltrationDrill",
}

# category -> alert type (AlertsHistory.json — different mapping)
_HISTORY_CATEGORY_MAP = {
    1: "missiles",
    2: "hostileAircraftIntrusion",
    3: "general",
    4: "general",
    5: "general",
    6: "general",
    7: "earthQuake",
    8: "earthQuake",
    9: "radiologicalEvent",
    10: "terroristInfiltration",
    11: "tsunami",
    12: "hazardousMaterials",
    13: "newsFlash",
    14: "newsFlash",
    15: "missilesDrill",
    16: "hostileAircraftIntrusionDrill",
    17: "generalDrill",
    18: "generalDrill",
    19: "generalDrill",
    20: "generalDrill",
    21: "earthQuakeDrill",
    22: "earthQuakeDrill",
    23: "radiologicalEventDrill",
    24: "terroristInfiltrationDrill",
    25: "tsunamiDrill",
    26: "hazardousMaterialsDrill",
}


def _fetch_raw(url: str, timeout: int = 10) -> bytes:
    """Fetch raw bytes from a URL with cache-busting timestamp."""
    ts = int(time.time())
    # oref.org.il uses a non-standard CA; verify=False is intentional here
    # (same behaviour as the original Node.js library which uses axios defaults).
    resp = requests.get(
        f"{url}?{ts}",
        headers=_HEADERS,
        timeout=timeout,
        verify=False,
    )
    resp.raise_for_status()
    if "/errorpage_adom/" in resp.text:
        raise ValueError("HFC API returned a temporary error page.")
    return resp.content


def _decode_body(raw: bytes) -> str:
    """Decode raw bytes handling UTF-16-LE BOM, UTF-8 BOM, or plain UTF-8."""
    if len(raw) >= 2 and raw[0] == 0xFF and raw[1] == 0xFE:
        # UTF-16-LE BOM
        body = raw[2:].decode("utf-16-le")
    elif len(raw) >= 3 and raw[0] == 0xEF and raw[1] == 0xBB and raw[2] == 0xBF:
        # UTF-8 BOM
        body = raw[3:].decode("utf-8")
    else:
        body = raw.decode("utf-8")

    # Strip NUL chars and stray unicode occasionally returned by the API
    body = body.replace("\x00", "").replace("\u0a7b", "")
    return body.strip()


def _extract_from_alerts_json(data: dict) -> list[dict]:
    """Parse the live Alerts.json response into a list of alert objects."""
    if not data.get("data"):
        return []

    try:
        cat = int(data.get("cat", 1))
    except (TypeError, ValueError):
        cat = 1

    alert = {
        "type": _CATEGORY_MAP.get(cat, "unknown"),
        "cities": [],
    }

    for city in data["data"]:
        if not city:
            continue
        city = city.strip()
        if "בדיקה" in city:
            continue
        if city not in alert["cities"]:
            alert["cities"].append(city)

    if data.get("title"):
        alert["instructions"] = data["title"]
    if data.get("id"):
        alert["id"] = data["id"]

    return [alert] if alert["cities"] else []


def _extract_from_history_json(items: list) -> list[dict]:
    """Parse the AlertsHistory.json response into a list of alert objects."""
    if not items:
        return []

    now = time.time()
    by_category: dict[int, dict] = {}
    alerts: list[dict] = []

    for item in items:
        if not item.get("alertDate") or not item.get("data") or not item.get("category"):
            continue

        try:
            unix = time.mktime(
                time.strptime(item["alertDate"], "%Y-%m-%d %H:%M:%S")
            )
        except (ValueError, OverflowError):
            continue

        if now - unix > 120:
            continue

        city = item["data"].strip()
        if "בדיקה" in city:
            continue

        try:
            cat = int(item["category"])
        except (TypeError, ValueError):
            cat = 0

        if cat not in by_category:
            bucket = {
                "type": _HISTORY_CATEGORY_MAP.get(cat, "unknown"),
                "cities": [],
            }
            if item.get("title"):
                bucket["instructions"] = item["title"]
            by_category[cat] = bucket
            alerts.append(bucket)

        bucket = by_category[cat]
        if city not in bucket["cities"]:
            bucket["cities"].append(city)

    return alerts


def get_active_alerts(timeout: int = 10) -> list[dict]:
    """
    Return a list of active alert objects from Pikud Ha'oref.
    Falls back to AlertsHistory.json if the primary feed is empty.
    Raises on network or parse errors.
    """
    raw = _fetch_raw(ALERTS_URL, timeout=timeout)
    body = _decode_body(raw)

    if not body:
        # Primary feed empty — try history feed
        raw = _fetch_raw(HISTORY_URL, timeout=timeout)
        body = _decode_body(raw)
        if not body:
            return []
        import json
        data = json.loads(body)
        if not isinstance(data, list):
            return []
        return _extract_from_history_json(data)

    import json
    data = json.loads(body)

    if isinstance(data, list):
        alerts = _extract_from_history_json(data)
    else:
        alerts = _extract_from_alerts_json(data)

    if not alerts:
        # Primary returned data but no active alerts — try history
        raw = _fetch_raw(HISTORY_URL, timeout=timeout)
        body = _decode_body(raw)
        if body:
            hist = json.loads(body)
            if isinstance(hist, list):
                alerts = _extract_from_history_json(hist)

    return alerts


if __name__ == "__main__":
    import json
    print("Fetching active alerts from Pikud Ha'oref...")
    alerts = get_active_alerts()
    print(f"Active alerts: {len(alerts)}")
    print(json.dumps(alerts, ensure_ascii=False, indent=2))
