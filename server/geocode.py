"""Address search and reverse geocoding for the Add-Location dialog.

Proxies Photon (komoot, OSM data, built for search-as-you-type) and falls back to Nominatim. Results are
cached in memory; both services ask for an identifying User-Agent and light use."""

from __future__ import annotations

import logging

import httpx

log = logging.getLogger("sitetwin.geocode")
USER_AGENT = "SiteTwin/0.1 (hackathon prototype; floor-plan locations)"
PHOTON = "https://photon.komoot.io"
NOMINATIM = "https://nominatim.openstreetmap.org"
TIMEOUT = httpx.Timeout(6.0, connect=3.0)
_cache: dict[tuple, object] = {}


class GeocodeError(RuntimeError):
    pass


def _photon_label(props: dict) -> str:
    street = " ".join(p for p in (props.get("street"), props.get("housenumber")) if p)
    place = " ".join(p for p in (props.get("postcode"), props.get("city") or props.get("town") or props.get("village")) if p)
    name = props.get("name")
    parts = [name if name and name != street else None, street or None, place or None,
             props.get("country") if props.get("countrycode", "").upper() not in ("DE", "") else None]
    return ", ".join(p for p in parts if p) or props.get("name") or ""


async def _get(url: str, params: dict) -> object:
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT}) as client:
        response = await client.get(url, params=params)
        response.raise_for_status()
        return response.json()


async def search(query: str, near: tuple[float, float] | None = None, limit: int = 6) -> list[dict]:
    query = query.strip()
    if len(query) < 3:
        return []
    key = ("search", query.lower(), near and (round(near[0], 1), round(near[1], 1)), limit)
    if key in _cache:
        return _cache[key]  # type: ignore[return-value]
    params: dict = {"q": query, "limit": limit, "lang": "de"}
    if near:
        params.update({"lat": near[0], "lon": near[1]})
    try:
        data = await _get(f"{PHOTON}/api/", params)
        results = [{"label": _photon_label(f.get("properties", {})),
                    "lat": f["geometry"]["coordinates"][1], "lon": f["geometry"]["coordinates"][0]}
                   for f in data.get("features", []) if f.get("geometry")]
    except (httpx.HTTPError, ValueError, KeyError) as error:
        log.info("photon search failed (%s); trying nominatim", error)
        try:
            data = await _get(f"{NOMINATIM}/search", {"q": query, "format": "jsonv2", "limit": limit,
                                                      "accept-language": "de"})
        except (httpx.HTTPError, ValueError) as fallback_error:
            raise GeocodeError(f"Address search is unavailable: {fallback_error}") from fallback_error
        results = [{"label": item.get("display_name", ""), "lat": float(item["lat"]), "lon": float(item["lon"])}
                   for item in data]
    results = [r for r in results if r["label"]]
    _cache[key] = results
    return results


async def reverse(lat: float, lon: float) -> dict:
    key = ("reverse", round(lat, 5), round(lon, 5))
    if key in _cache:
        return _cache[key]  # type: ignore[return-value]
    label = ""
    try:
        data = await _get(f"{PHOTON}/reverse", {"lat": lat, "lon": lon, "lang": "de"})
        features = data.get("features", [])
        if features:
            label = _photon_label(features[0].get("properties", {}))
    except (httpx.HTTPError, ValueError, KeyError) as error:
        log.info("photon reverse failed (%s); trying nominatim", error)
        try:
            data = await _get(f"{NOMINATIM}/reverse", {"lat": lat, "lon": lon, "format": "jsonv2",
                                                       "accept-language": "de"})
            label = data.get("display_name", "")
        except (httpx.HTTPError, ValueError) as fallback_error:
            raise GeocodeError(f"Reverse geocoding is unavailable: {fallback_error}") from fallback_error
    result = {"label": label, "lat": lat, "lon": lon}
    _cache[key] = result
    return result
