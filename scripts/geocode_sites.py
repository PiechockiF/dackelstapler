"""Build data/sites.json: one Site per OSM and procedural building across train/dev/test.

OSM buildings are resolved with the Overpass API (`way(<id>);out center;`, batched and cached in
storage/overpass_cache.json). If the network is unavailable they fall back to approximate known
Munich coordinates with demo_location=true. Procedural buildings get deterministic, plausible
coordinates in Munich industrial / campus areas, always demo_location=true.

Run:  uv run python scripts/geocode_sites.py [--offline]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "sites.json"
CACHE = ROOT / "storage" / "overpass_cache.json"
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "SiteTwin-hackathon/0.1 (Industrial Agents Hackathon 2026; contact: team sitetwin)"

# Approximate anchors when Overpass is unreachable.
TUM_MAIN = (48.1497, 11.5679)
GARCHING = (48.2650, 11.6710)
AIRPORT_T2 = (48.3537, 11.7861)
PASING_ARCADEN = (48.1497, 11.4630)
KNOWN_FALLBACKS = {
    "Terminal 2": AIRPORT_T2,
    "Pasing Arcaden": PASING_ARCADEN,
    "N3": TUM_MAIN, "N8": TUM_MAIN, "Arcisstraße 21": TUM_MAIN, "Hauptgebäude": TUM_MAIN,
    "Thierschbau": TUM_MAIN, "Mensa Arcisstraße": TUM_MAIN, "Wirtschaftswissenschaften": TUM_MAIN,
    "Landwirtschaftsbau": TUM_MAIN, "U-Trakt": TUM_MAIN, "Wolf-Ferrari-Haus": TUM_MAIN,
    "StudiTUM": GARCHING,
    "TUM School of Computation, Information and Technology (CIT), Departments Informatik und Mathematik": GARCHING,
    "TUM 4107 Institutsgebäude 3": GARCHING,
}

# Procedural placement areas (lat, lon, radius in metres).
FACTORY_AREAS = {
    "Freiham": (48.1340, 11.4110, 700),
    "Allach": (48.1950, 11.4630, 700),
    "Moosach": (48.1870, 11.5090, 500),
    "Garching-Hochbrück": (48.2480, 11.6280, 500),
    "Feldkirchen": (48.1500, 11.7300, 600),
}
CAMPUS_AREAS = {
    "Garching Forschungszentrum": (48.2650, 11.6710, 600),
    "Martinsried": (48.1100, 11.4600, 450),
}
# Name hint → preferred factory area, so "Werk Garching" lands in Garching-Hochbrück etc.
FACTORY_HINTS = {"Garching": "Garching-Hochbrück", "Ost": "Feldkirchen", "West": "Freiham",
                 "Nord": "Allach", "Isar": "Moosach", "Süd": "Freiham"}


def stable_unit(key: str, salt: str) -> float:
    digest = hashlib.sha256(f"{key}:{salt}".encode()).hexdigest()
    return int(digest[:12], 16) / float(16**12)


def jitter(lat: float, lon: float, radius_m: float, key: str) -> tuple[float, float]:
    """Deterministic point within radius_m of (lat, lon)."""
    angle = 2 * math.pi * stable_unit(key, "angle")
    distance = radius_m * math.sqrt(stable_unit(key, "dist"))
    dlat = distance * math.cos(angle) / 111_320
    dlon = distance * math.sin(angle) / (111_320 * math.cos(math.radians(lat)))
    return round(lat + dlat, 6), round(lon + dlon, 6)


def read_manifest() -> list[dict]:
    with (DATA / "manifest.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return [row for row in rows if row["source"] in ("osm_indoor", "procedural")]


def kind_for(row: dict) -> str:
    building_id, name = row["building_id"], row["name"]
    if building_id.startswith("proc-factory"):
        return "factory"
    if building_id.startswith("proc-campus"):
        return "campus"
    lowered = name.lower()
    if "terminal" in lowered:
        return "airport"
    if "arcaden" in lowered:
        return "mall"
    if "mensa" in lowered:
        return "other"
    if any(word in lowered for word in ("tum", "arcis", "gebäude", "bau", "trakt", "haus", "n3", "n8", "wissenschaft")):
        return "campus"
    return "office"


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    return {}


def overpass_centers(way_ids: list[str], cache: dict) -> dict[str, tuple[float, float]]:
    missing = [way for way in way_ids if way not in cache]
    if missing:
        query = "[out:json][timeout:60];(" + "".join(f"way({way});" for way in missing) + ");out center;"
        for url in OVERPASS_URLS:
            try:
                response = httpx.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=90)
                response.raise_for_status()
                for element in response.json().get("elements", []):
                    center = element.get("center")
                    if center:
                        cache[str(element["id"])] = [center["lat"], center["lon"]]
                CACHE.parent.mkdir(parents=True, exist_ok=True)
                CACHE.write_text(json.dumps(cache, indent=1), encoding="utf-8")
                break
            except (httpx.HTTPError, ValueError) as error:
                print(f"overpass {url} failed: {error}", file=sys.stderr)
    return {way: tuple(cache[way]) for way in way_ids if way in cache}


def floors_of(row: dict) -> int:
    try:
        return int(row["floors"])
    except (KeyError, ValueError):
        return 1


def build_sites(offline: bool) -> list[dict]:
    rows = read_manifest()
    osm_ways = [row["building_id"].removeprefix("osm-way") for row in rows if row["source"] == "osm_indoor"]
    centers = {} if offline else overpass_centers(osm_ways, load_cache())
    if offline:
        cache = load_cache()
        centers = {way: tuple(cache[way]) for way in osm_ways if way in cache}

    sites = []
    for row in rows:
        building_id = row["building_id"]
        kind = kind_for(row)
        demo = True
        if row["source"] == "osm_indoor":
            way = building_id.removeprefix("osm-way")
            if way in centers:
                lat, lon = centers[way]
                demo = False
            else:
                anchor = KNOWN_FALLBACKS.get(row["name"], TUM_MAIN)
                lat, lon = jitter(*anchor, 250, building_id)
        elif kind == "factory":
            area = next((FACTORY_HINTS[hint] for hint in FACTORY_HINTS if hint in row["name"]), None)
            if area is None:
                names = sorted(FACTORY_AREAS)
                area = names[int(stable_unit(building_id, "area") * len(names))]
            lat, lon = jitter(*FACTORY_AREAS[area][:2], FACTORY_AREAS[area][2], building_id)
        else:
            names = sorted(CAMPUS_AREAS)
            area = names[0] if stable_unit(building_id, "campus") < 0.7 else names[1]
            lat, lon = jitter(*CAMPUS_AREAS[area][:2], CAMPUS_AREAS[area][2], building_id)
        sites.append({
            "id": building_id,
            "name": row["name"],
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "source": row["source"],
            "building_id": building_id,
            "data_path": f"data/{row['path']}",
            "floors": floors_of(row),
            "demo_location": demo,
            "kind": kind,
        })
    # Hero site first, then the rest sorted by kind/name for stable output.
    sites.sort(key=lambda site: (site["id"] != "proc-factory-dev-003", site["kind"], site["name"], site["id"]))
    return sites


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="skip Overpass, use cache/fallbacks only")
    args = parser.parse_args()
    sites = build_sites(args.offline)
    OUT.write_text(json.dumps(sites, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    real = sum(1 for site in sites if not site["demo_location"])
    print(f"wrote {len(sites)} sites to {OUT.relative_to(ROOT)} ({real} with real OSM coordinates)")


if __name__ == "__main__":
    main()
