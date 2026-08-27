# Perth cycleways → DuckDB (GIS)

Pulls Perth cycle infrastructure from OpenStreetMap via the **Overpass API**,
buckets every segment into three classes, and loads it into a **DuckDB** table
with a real spatial geometry column.

Buckets:

| bucket | meaning | typical OSM tags |
| --- | --- | --- |
| `separated` | physically separated from cars *and* pedestrians — a bike-only path, a segregated shared path, or a track beside the road | `highway=cycleway` (no foot access, or `segregated=yes`); road with `cycleway*=track` |
| `on-road` | painted lane / shared-lane on the carriageway | road with `cycleway*=lane` / `shared_lane` |
| `shared-with-pedestrians` | off-road dual-use path (Perth PSP-style shared path) | `highway=cycleway` allowing foot with `segregated≠yes`; `highway=path`/`footway` with `bicycle=designated`/`yes` |

## Files

- `overpass_perth_cycleways.overpassql` — the raw Overpass query (paste into
  <https://overpass-turbo.eu> to eyeball it on a map). The Python script keeps
  its own parameterised copy of the same query.
- `load_cycleways.py` — fetch → bucket → load into DuckDB. Uses
  [PEP 723](https://peps.python.org/pep-0723/) inline dependencies so `uv`
  builds an isolated venv automatically.

## Run it (uv)

`uv` reads the dependency block at the top of the script and creates/uses an
isolated virtualenv — no manual `pip install` needed:

```bash
uv run load_cycleways.py
```

That writes `perth_cycleways.duckdb` with:

- table **`perth_cycleways`** — one row per OSM way: `osm_id`, `bucket`,
  `length_m`, tag columns (`highway`, `cycleway*`, `bicycle`, `foot`,
  `segregated`, `surface`, `name`), and a spatial `geom` (LineString, WGS84).
- view **`bucket_summary`** — segment count and km per bucket.

### Options

```bash
uv run load_cycleways.py --db out.duckdb --geojson out.geojson --keep-geojson
uv run load_cycleways.py --bbox -32.70 115.55 -31.45 116.35   # south west north east
uv run load_cycleways.py --from-geojson existing.geojson       # skip Overpass
```

If you'd rather manage the venv explicitly:

```bash
uv venv
uv pip install requests duckdb
uv run python load_cycleways.py
```

## Querying the result

```bash
uv run --with duckdb python - <<'PY'
import duckdb
con = duckdb.connect("perth_cycleways.duckdb")
con.execute("LOAD spatial;")
print(con.execute("SELECT * FROM bucket_summary").fetchall())
# separated segments longer than 1 km, as WKT
for row in con.execute("""
    SELECT name, round(length_m/1000,2) km, ST_AsText(geom)
    FROM perth_cycleways
    WHERE bucket='separated' AND length_m > 1000
    ORDER BY length_m DESC LIMIT 5
""").fetchall():
    print(row)
PY
```

## Notes / caveats

- **Classification lives in `classify()`** in `load_cycleways.py` — the rules
  are documented there and easy to adjust (e.g. if you'd rather count
  `cycleway=track` as on-road, or treat `segregated=yes` as shared).
- **Length is geodesic** (haversine over the vertices), computed in Python and
  stored as `length_m`. This DuckDB spatial build ships without PROJ, so
  `ST_Transform` / `ST_Length_Spheroid` return `NaN`; the precomputed column
  avoids that.
- **Data quality is OSM's.** Coverage and tagging consistency vary. For an
  authoritative government cross-check, see Transport WA's Long-Term Cycle
  Network (data.wa.gov.au, DOT-035) and Main Roads WA's Principal Shared Paths.
- **Network:** the script needs outbound HTTPS to a public Overpass endpoint.
  In a locked-down/egress-restricted environment the fetch will fail — use
  `--from-geojson` with a file exported from overpass-turbo instead.
