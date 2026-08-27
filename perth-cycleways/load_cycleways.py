# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31",
#     "duckdb>=1.0",
# ]
# ///
"""
Fetch Perth cycle infrastructure from the Overpass API, bucket each segment
into separated / on-road / shared-with-pedestrians, and load it into a DuckDB
table with a real (spatial) geometry column.

Run with uv (creates/uses an isolated venv from the inline metadata above):

    uv run load_cycleways.py

Useful flags:

    uv run load_cycleways.py --db perth_cycleways.duckdb --geojson out.geojson
    uv run load_cycleways.py --bbox -32.70 115.55 -31.45 116.35   # S W N E
    uv run load_cycleways.py --keep-geojson    # don't delete the intermediate file

Output: a DuckDB database (default perth_cycleways.duckdb) with table
`perth_cycleways` (one row per OSM way, geometry column `geom`, plus a `bucket`
column) and a convenience view `bucket_summary`.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import duckdb
import requests

# Public Overpass endpoints, tried in order on failure.
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Default greater-Perth metro bbox: south, west, north, east.
DEFAULT_BBOX = (-32.70, 115.55, -31.45, 116.35)


def build_query(bbox: tuple[float, float, float, float]) -> str:
    """Overpass QL that returns the superset of cycle ways for `bbox`.

    Mirrors overpass_perth_cycleways.overpassql; kept inline so the script is
    self-contained and the bbox is parameterised.
    """
    s, w, n, e = bbox
    b = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:180];
(
  way["highway"="cycleway"]({b});
  way["highway"]["cycleway"~"^(lane|track|shared_lane|opposite_lane|opposite_track)$"]({b});
  way["highway"]["cycleway:left"~"^(lane|track|shared_lane)$"]({b});
  way["highway"]["cycleway:right"~"^(lane|track|shared_lane)$"]({b});
  way["highway"]["cycleway:both"~"^(lane|track|shared_lane)$"]({b});
  way["highway"="path"]["bicycle"~"^(designated|yes)$"]({b});
  way["highway"="footway"]["bicycle"~"^(designated|yes)$"]({b});
);
out tags geom;
""".strip()


def fetch_overpass(query: str, retries: int = 4) -> dict:
    """POST the query to Overpass, cycling endpoints and backing off on failure."""
    last_err: Exception | None = None
    for attempt in range(retries):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            print(f"[overpass] POST {endpoint} (attempt {attempt + 1}/{retries})",
                  file=sys.stderr)
            resp = requests.post(endpoint, data={"data": query}, timeout=300)
            if resp.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"{resp.status_code} from {endpoint}")
            resp.raise_for_status()
            return resp.json()
        except Exception as err:  # noqa: BLE001 - retry on anything transient
            last_err = err
            wait = 2 ** (attempt + 1)
            print(f"[overpass] {err} -> retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError(f"Overpass request failed after {retries} attempts: {last_err}")


# Values that mean "bikes have their own space, apart from cars and pedestrians".
_TRACK_VALUES = {"track", "opposite_track"}
_LANE_VALUES = {"lane", "shared_lane", "opposite_lane"}
_FOOT_ALLOWED = {"yes", "designated", "permissive"}


def classify(tags: dict[str, str]) -> str:
    """Bucket one OSM way into separated / on-road / shared-with-pedestrians.

    Rules (documented so they're easy to tweak):
      * A road (not a cycleway/path/footway) carrying cycle tags:
          - cycleway*=track          -> separated  (physical track beside road)
          - cycleway*=lane/shared    -> on-road    (paint on the carriageway)
      * highway=cycleway (dedicated bike path):
          - segregated=yes           -> separated  (bike lane split from ped lane)
          - foot allowed             -> shared-with-pedestrians (dual-use path)
          - otherwise                -> separated  (bike-only path)
      * highway=path / footway that allows bikes
                                     -> shared-with-pedestrians
    """
    hw = tags.get("highway")
    cw_values = {
        tags.get("cycleway"),
        tags.get("cycleway:left"),
        tags.get("cycleway:right"),
        tags.get("cycleway:both"),
    }
    cw_values.discard(None)

    if hw not in ("cycleway", "path", "footway"):
        if cw_values & _TRACK_VALUES:
            return "separated"
        if cw_values & _LANE_VALUES:
            return "on-road"
        return "on-road"  # a road that matched the query some other way

    if hw == "cycleway":
        if tags.get("segregated") == "yes":
            return "separated"
        if tags.get("foot") in _FOOT_ALLOWED:
            return "shared-with-pedestrians"
        return "separated"

    # highway == "path" or "footway" (bikes allowed -> dual use)
    return "shared-with-pedestrians"


def _length_m(coords: list[list[float]]) -> float:
    """Geodesic length of a lon/lat LineString in metres (haversine sum).

    Computed here rather than in SQL because the bundled DuckDB spatial
    extension has no PROJ/spheroid support (ST_Transform / ST_Length_Spheroid
    return NaN in this build).
    """
    r = 6371000.0  # mean Earth radius, metres
    total = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        p1, p2 = math.radians(lat1), math.radians(lat2)
        dp = math.radians(lat2 - lat1)
        dl = math.radians(lon2 - lon1)
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        total += 2 * r * math.asin(math.sqrt(a))
    return round(total, 1)


def to_geojson(overpass: dict) -> dict:
    """Turn Overpass `out geom` ways into a GeoJSON FeatureCollection.

    Every feature carries the *same* property keys so DuckDB's ST_Read infers a
    stable, complete schema.
    """
    prop_keys = [
        "name", "highway", "cycleway", "cycleway_left", "cycleway_right",
        "cycleway_both", "bicycle", "foot", "segregated", "surface",
    ]
    features = []
    for el in overpass.get("elements", []):
        if el.get("type") != "way" or not el.get("geometry"):
            continue
        tags = el.get("tags", {})
        coords = [[pt["lon"], pt["lat"]] for pt in el["geometry"]]
        if len(coords) < 2:
            continue
        props = {
            "osm_id": el["id"],
            "osm_type": "way",
            "bucket": classify(tags),
            "length_m": _length_m(coords),
        }
        for key in prop_keys:
            props[key] = tags.get(key.replace("_", ":"))
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords},
        })
    return {"type": "FeatureCollection", "features": features}


def load_into_duckdb(geojson_path: Path, db_path: Path, table: str) -> None:
    """Load the GeoJSON into DuckDB via the spatial extension."""
    con = duckdb.connect(str(db_path))
    con.execute("INSTALL spatial;")
    con.execute("LOAD spatial;")
    con.execute(
        f"CREATE OR REPLACE TABLE {table} AS "
        f"SELECT * FROM ST_Read(?)",
        [str(geojson_path)],
    )
    # length_m is precomputed (haversine) in to_geojson; only present when the
    # GeoJSON came from this script. Fall back to counts-only for foreign files.
    cols = [r[1] for r in con.execute(
        f"PRAGMA table_info('{table}')").fetchall()]
    has_len = "length_m" in cols
    if has_len:
        con.execute(
            f"CREATE OR REPLACE VIEW bucket_summary AS "
            f"SELECT bucket, count(*) AS segments, "
            f"       round(sum(length_m) / 1000, 1) AS km "
            f"FROM {table} GROUP BY bucket ORDER BY km DESC"
        )
    else:
        con.execute(
            f"CREATE OR REPLACE VIEW bucket_summary AS "
            f"SELECT bucket, count(*) AS segments "
            f"FROM {table} GROUP BY bucket ORDER BY segments DESC"
        )
    print("\n=== bucket_summary ===")
    for row in con.execute("SELECT * FROM bucket_summary").fetchall():
        km = f"   {row[2]} km" if has_len else ""
        print(f"  {row[0]:<24} {row[1]:>6} segments{km}")
    total = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    print(f"\nLoaded {total} segments into {db_path}::{table}")
    con.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="perth_cycleways.duckdb", type=Path)
    parser.add_argument("--table", default="perth_cycleways")
    parser.add_argument("--geojson", default="perth_cycleways.geojson", type=Path)
    parser.add_argument(
        "--bbox", nargs=4, type=float, metavar=("S", "W", "N", "E"),
        default=list(DEFAULT_BBOX), help="Bounding box: south west north east",
    )
    parser.add_argument("--keep-geojson", action="store_true",
                        help="Keep the intermediate GeoJSON file")
    parser.add_argument("--from-geojson", type=Path, default=None,
                        help="Skip Overpass; load an existing GeoJSON instead")
    args = parser.parse_args()

    if args.from_geojson:
        geojson_path = args.from_geojson
        print(f"[geojson] loading existing {geojson_path}", file=sys.stderr)
    else:
        query = build_query(tuple(args.bbox))
        data = fetch_overpass(query)
        fc = to_geojson(data)
        print(f"[geojson] {len(fc['features'])} features", file=sys.stderr)
        geojson_path = args.geojson
        geojson_path.write_text(json.dumps(fc))

    load_into_duckdb(geojson_path, args.db, args.table)

    if not args.keep_geojson and not args.from_geojson:
        os.remove(geojson_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
