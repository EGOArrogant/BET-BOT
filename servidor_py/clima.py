"""Clima a la hora de cada partido con Open-Meteo (gratis, sin clave, uso personal no comercial).

Licencia de los datos: CC BY 4.0 — "Weather data by Open-Meteo.com". Se cachea para no abusar:
la ubicación de cada ciudad para siempre y el pronóstico por 1 hora.
"""

from __future__ import annotations

import datetime as dt
import threading
import time

import httpx

UA = {"User-Agent": "BetBotMX/3.5 (app personal de analisis)"}
_geo: dict[str, tuple | None] = {}
_fc: dict[tuple, tuple[float, dict]] = {}
_lock = threading.Lock()


def _geocode(city: str):
    key = city.strip().lower()
    if key in _geo:
        return _geo[key]
    try:
        r = httpx.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": city, "count": 1, "language": "es", "format": "json"},
                      headers=UA, timeout=15)
        res = (r.json().get("results") or [None])[0] if r.status_code == 200 else None
        val = (round(res["latitude"], 3), round(res["longitude"], 3)) if res else None
    except (httpx.HTTPError, ValueError, KeyError):
        val = None
    _geo[key] = val
    return val


def _forecast(lat, lon, day: str):
    key = (lat, lon, day)
    hit = _fc.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    r = httpx.get("https://api.open-meteo.com/v1/forecast", headers=UA, timeout=20, params={
        "latitude": lat, "longitude": lon, "timezone": "UTC", "start_date": day, "end_date": day,
        "hourly": "temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m",
    })
    d = r.json() if r.status_code == 200 else {}
    _fc[key] = (time.time(), d)
    return d


def at(item: dict) -> dict | None:
    """item: {city | lat+lon, date (ISO del inicio)}. Devuelve el clima de la hora más cercana al inicio."""
    try:
        when = dt.datetime.fromisoformat(str(item.get("date", "")).replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    except ValueError:
        return None
    if when - dt.datetime.now(dt.timezone.utc) > dt.timedelta(days=15):
        return None  # el pronóstico solo llega a ~16 días
    with _lock:
        if item.get("lat") is not None and item.get("lon") is not None:
            loc = (round(float(item["lat"]), 3), round(float(item["lon"]), 3))
        elif item.get("city"):
            loc = _geocode(str(item["city"]))
        else:
            loc = None
        if not loc:
            return None
        try:
            d = _forecast(loc[0], loc[1], when.date().isoformat())
        except httpx.HTTPError:
            return None
    h = d.get("hourly") or {}
    times = h.get("time") or []
    if not times:
        return None
    target = when.strftime("%Y-%m-%dT%H:00")
    i = times.index(target) if target in times else min(range(len(times)), key=lambda k: abs(int(times[k][11:13]) - when.hour))
    pick = lambda k: (h.get(k) or [None] * len(times))[i]  # noqa: E731
    return {"temp": pick("temperature_2m"), "rainProb": pick("precipitation_probability"), "rain": pick("precipitation"),
            "wind": pick("wind_speed_10m"), "gust": pick("wind_gusts_10m"), "lat": loc[0], "lon": loc[1], "source": "Open-Meteo.com"}
