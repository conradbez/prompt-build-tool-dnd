/*
 * Perth cycle infrastructure — Overpass QL
 * ----------------------------------------
 * Pulls every way in the greater-Perth bounding box that carries cycle
 * infrastructure, so it can be bucketed downstream into:
 *
 *   separated               physically separated from the carriageway and
 *                           from pedestrians (bike-only path, or a track
 *                           beside the road, or a segregated shared path)
 *   on-road                 painted lane / shared-lane on the carriageway
 *   shared-with-pedestrians off-road dual-use path (PSP-style shared path)
 *
 * The bucketing itself is done in load_cycleways.py (see classify()), because
 * Overpass QL cannot attach a derived property to a feature. This query's job
 * is to return the right *superset* of ways together with their tags + geometry.
 *
 * Bounding box below is greater-Perth metro (south,west,north,east).
 * load_cycleways.py substitutes its own bbox via the {{bbox}} placeholder,
 * so this file is directly runnable in https://overpass-turbo.eu as well.
 */
[out:json][timeout:180];

// Greater Perth metro bbox: south, west, north, east
(
  // ---- Dedicated cycleways (off-road bike paths; may or may not allow foot)
  way["highway"="cycleway"](-32.70,115.55,-31.45,116.35);

  // ---- Cycle infrastructure tagged on a road (lanes / roadside tracks)
  way["highway"]["cycleway"~"^(lane|track|shared_lane|opposite_lane|opposite_track)$"](-32.70,115.55,-31.45,116.35);
  way["highway"]["cycleway:left"~"^(lane|track|shared_lane)$"](-32.70,115.55,-31.45,116.35);
  way["highway"]["cycleway:right"~"^(lane|track|shared_lane)$"](-32.70,115.55,-31.45,116.35);
  way["highway"]["cycleway:both"~"^(lane|track|shared_lane)$"](-32.70,115.55,-31.45,116.35);

  // ---- Shared-use / dual-use paths that explicitly allow bikes
  way["highway"="path"]["bicycle"~"^(designated|yes)$"](-32.70,115.55,-31.45,116.35);
  way["highway"="footway"]["bicycle"~"^(designated|yes)$"](-32.70,115.55,-31.45,116.35);
);

// tags + full geometry, no separate node dump
out tags geom;
