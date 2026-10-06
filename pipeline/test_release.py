import json

import pytest

from pipeline import deflock, refresh_cameras
from pipeline.pack import pack_meta, pack_sections, write_pack
from pipeline.regions import Region, get_region, load_regions
from pipeline.release import HASH_CHARS, SCHEMA, sha256_of, stage_release

DALLAS = Region("dallas", "Dallas", (-97.05, 32.63, -96.53, 32.94), ("north-america/us/texas",),
                ((-96.85692, 32.73077), (-96.66394, 32.85072)))


def test_shipped_regions_are_valid():
    from pipeline.regions import US, US_STATES

    regions = load_regions()
    assert {r.id for r in regions} >= {"dallas", "charlotte"}
    assert get_region("dallas").geofabrik_urls == ["https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf"]
    charlotte = get_region("charlotte")
    assert charlotte.states == ["NC", "SC"] and charlotte.group == "North Carolina" and charlotte.batch == "southeast"
    for r in regions:  # every extract is a known state, so it has a batch and a name in the app
        assert all(g.removeprefix(US) in US_STATES for g in r.geofabrik), r.id
        w, s, e, n = r.clip_bbox
        assert (e - w) * (n - s) <= 0.75, f"{r.id} is bigger than any metro needs"


def test_bad_regions_are_rejected(tmp_path):
    cfg = tmp_path / "r.json"
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [1, 2, 0, 3], "geofabrik": "x"}]}))
    with pytest.raises(ValueError, match="invalid clip_bbox"):
        load_regions(cfg)
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [0, 0, 1, 1], "geofabrik": "x"}] * 2}))
    with pytest.raises(ValueError, match="duplicate"):
        load_regions(cfg)
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [0, 0, 1, 1], "geofabrik": []}]}))
    with pytest.raises(ValueError, match="geofabrik"):
        load_regions(cfg)
    cfg.write_text(json.dumps({"regions": [{"id": "A b", "name": "A", "clip_bbox": [0, 0, 1, 1], "geofabrik": "x"}]}))
    with pytest.raises(ValueError, match="lowercase"):
        load_regions(cfg)


def test_a_single_extract_may_be_a_plain_string(tmp_path):
    cfg = tmp_path / "r.json"
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [0, 0, 1, 1],
                                            "geofabrik": "north-america/us/ohio"}]}))
    (r,) = load_regions(cfg)
    assert r.geofabrik == ("north-america/us/ohio",) and r.states == ["OH"] and r.batch == "ohio-valley"


def test_tile_origins_cover_the_bbox():
    # Dallas sits in the 20/-100 tile; a box straddling lat 40 / lon -100 needs four.
    assert deflock.tile_origins((-97.05, 32.63, -96.53, 32.94)) == [(20, -100)]
    assert sorted(deflock.tile_origins((-101, 39, -99, 41))) == [(20, -120), (20, -100), (40, -120), (40, -100)]


def _tiles(records_by_url):
    def fetch(url):
        return records_by_url.get(url)
    return fetch


def test_fetch_cameras_filters_dedupes_and_sorts():
    tile = [
        {"id": 5, "lat": 32.7, "lon": -96.8, "tags": {"manufacturer": "Flock Safety"}},
        {"id": 2, "lat": 32.8, "lon": -96.7, "tags": {}},
        {"id": 5, "lat": 32.7, "lon": -96.8, "tags": {"manufacturer": "Flock Safety"}},  # duplicate
        {"id": 9, "lat": 40.0, "lon": -75.0, "tags": {}},  # far outside
    ]
    fetch = _tiles({f"{deflock.CDN}/20/-100.json": json.dumps(tile).encode()})
    got = deflock.fetch_cameras(DALLAS.clip_bbox, fetch=fetch)
    assert [c["id"] for c in got] == [2, 5]


def test_missing_tiles_are_not_errors():
    assert deflock.fetch_cameras(DALLAS.clip_bbox, fetch=lambda url: None) == []


def test_caching_fetches_each_tile_once():
    calls = []
    fetch = deflock.caching(lambda url: calls.append(url) or b"[]")
    for _ in range(3):
        deflock.fetch_cameras(DALLAS.clip_bbox, fetch=fetch)
    assert calls == [f"{deflock.CDN}/20/-100.json"]


def test_refresh_refuses_empty_or_collapsed_feeds(tmp_path):
    def cams(n):
        return json.dumps([{"id": i, "lat": 32.7, "lon": -96.8, "tags": {}} for i in range(1, n + 1)]).encode()

    url = f"{deflock.CDN}/20/-100.json"
    with pytest.raises(RuntimeError, match="no cameras"):
        refresh_cameras.refresh(DALLAS, tmp_path, fetch=_tiles({}))
    assert refresh_cameras.refresh(DALLAS, tmp_path, fetch=_tiles({url: cams(10)})) == 10
    feed = json.loads((tmp_path / "cameras" / "dallas.json").read_text())
    w, s, e, n = DALLAS.clip_bbox
    assert len(feed["cameras"]) == 10 and feed["bbox"] == [w - 0.03, s - 0.03, e + 0.03, n + 0.03]
    with pytest.raises(RuntimeError, match="shrank"):
        refresh_cameras.refresh(DALLAS, tmp_path, fetch=_tiles({url: cams(3)}))
    assert len(json.loads((tmp_path / "cameras" / "dallas.json").read_text())["cameras"]) == 10  # untouched
    assert refresh_cameras.refresh(DALLAS, tmp_path, fetch=_tiles({url: cams(9)})) == 9  # a small dip is fine


@pytest.fixture
def data_dir(tmp_path):
    from pipeline.osm_graph import build_graph
    from pipeline.fixtures import grid_osm

    osm = tmp_path / "grid.osm"
    osm.write_text(grid_osm())
    g = build_graph(osm)
    data = tmp_path / "data"
    (data / "packs").mkdir(parents=True)
    (data / "basemap" / "assets" / "fonts" / "Noto Sans Regular").mkdir(parents=True)
    write_pack(data / "packs" / "dallas.fwr", pack_meta(g, "grid.osm", "test"), pack_sections(g))
    (data / "packs" / "dallas.cameras.json").write_text(json.dumps({"cameras": [{"id": 1}]}))
    (data / "basemap" / "dallas.pmtiles").write_bytes(b"PMTiles" + bytes(range(200)))
    (data / "basemap" / "assets" / "fonts" / "Noto Sans Regular" / "0-255.pbf").write_bytes(b"glyphs")
    return data


def test_stage_release_builds_the_tree_and_manifest(data_dir, tmp_path):
    import gzip

    out = tmp_path / "release"
    manifest = stage_release(data_dir, out, [DALLAS, Region("elsewhere", "Elsewhere", (0, 0, 1, 1), ("x",))])
    assert manifest["schema"] == SCHEMA == 2
    assert [r["id"] for r in manifest["regions"]] == ["dallas"]  # the region without data is skipped
    r = manifest["regions"][0]
    pack = out / r["pack"]["path"]
    assert pack.name == f"dallas.{sha256_of(pack)[:HASH_CHARS]}.fwr.gz" and r["pack"]["encoding"] == "gzip"
    assert gzip.decompress(pack.read_bytes()) == (data_dir / "packs" / "dallas.fwr").read_bytes()
    assert r["pack"]["sha256"] == sha256_of(pack) and r["pack"]["bytes"] == pack.stat().st_size
    assert r["pack"]["raw_bytes"] == (data_dir / "packs" / "dallas.fwr").stat().st_size and r["pack"]["edges"] == 78
    assert (r["group"], r["states"]) == ("Texas", ["TX"])
    assert (out / r["basemap"]["path"]).read_bytes().startswith(b"PMTiles")
    assert json.loads((out / r["cameras"]["path"]).read_text()) == {"cameras": [{"id": 1}]}
    assert (out / "basemap/assets/fonts/Noto Sans Regular/0-255.pbf").read_bytes() == b"glyphs"
    assert manifest["assets"]["sprite"] == "basemap/assets/sprites/v4/light"
    assert len(r["bbox"]) == 4 and len(r["center"]) == 2
    assert r["example"] == {"from": [-96.85692, 32.73077], "to": [-96.66394, 32.85072]}
    assert json.loads((out / "regions.json").read_text()) == manifest
    assert sorted(p.name for p in (out / "packs").iterdir()) == [pack.name]  # no temporary files left


def test_restaging_replaces_old_versions_and_keeps_a_fresher_feed(data_dir, tmp_path):
    out = tmp_path / "release"
    first = stage_release(data_dir, out, [DALLAS])["regions"][0]["pack"]["path"]
    (out / "cameras" / "dallas.json").write_text(json.dumps({"cameras": [{"id": 1}, {"id": 2}]}))  # an hourly refresh
    (data_dir / "basemap" / "dallas.pmtiles").write_bytes(b"PMTiles-v2")
    second = stage_release(data_dir, out, [DALLAS])
    assert second["regions"][0]["pack"]["path"] == first  # unchanged pack, same name (gzip is deterministic)
    assert len(list((out / "basemap").glob("dallas.*.pmtiles"))) == 1  # the old basemap is gone
    assert len(json.loads((out / "cameras" / "dallas.json").read_text())["cameras"]) == 2  # refresh kept


def _entry(rid, tag="new"):
    return {"id": rid, "name": rid.title(), "pack": {"path": f"packs/{rid}.{tag}.fwr.gz", "bytes": 1, "edges": 1},
            "basemap": {"path": f"basemap/{rid}.{tag}.pmtiles", "bytes": 1}, "cameras": {"path": f"cameras/{rid}.json"}}


def test_assemble_keeps_live_regions_that_were_not_rebuilt(tmp_path):
    from pipeline.release import assemble

    regions = [Region(i, i.title(), (0, 0, 1, 1), ("x",)) for i in ("a", "b", "c", "d")]
    out = tmp_path / "release"
    (out / "cameras").mkdir(parents=True)
    for rid in ("a", "b", "c"):
        (out / "cameras" / f"{rid}.json").write_text("{}")
    live = {"schema": SCHEMA, "regions": [_entry("a", "old"), _entry("b", "old"), _entry("gone", "old")]}
    m = assemble(out, regions, [_entry("b"), _entry("c"), _entry("d")], live)
    assert [(e["id"], e["pack"]["path"]) for e in m["regions"]] == [
        ("a", "packs/a.old.fwr.gz"),  # not rebuilt: keeps what's online
        ("b", "packs/b.new.fwr.gz"),  # rebuilt: the new files
        ("c", "packs/c.new.fwr.gz"),  # new region
    ]  # "d" has no camera feed and "gone" left regions.json: both left out
    old_schema = assemble(out, regions, [_entry("c")], {"schema": 1, "regions": [_entry("a", "old")]})
    assert [e["id"] for e in old_schema["regions"]] == ["c"]  # an older layout isn't reused
    with pytest.raises(RuntimeError, match="nothing to release"):
        assemble(out, regions, [_entry("d")])


def test_part_then_assemble_from_the_command_line(data_dir, tmp_path, monkeypatch):
    from pipeline import release

    out = tmp_path / "release"
    monkeypatch.setattr(release, "load_regions", lambda: [DALLAS])
    assert release.main(["--data", str(data_dir), "--out", str(out), "--part", "texas", "--region", "dallas"]) == 0
    part = json.loads((out / "parts" / "texas.json").read_text())
    assert [e["id"] for e in part["regions"]] == ["dallas"] and not (out / "regions.json").exists()
    (out / "cameras").mkdir()
    (out / "cameras" / "dallas.json").write_text("{}")
    assert release.main(["--data", str(data_dir), "--out", str(out), "--assemble",
                         "--live", str(tmp_path / "none.json")]) == 0
    manifest = json.loads((out / "regions.json").read_text())
    assert [e["id"] for e in manifest["regions"]] == ["dallas"]
    assert (out / "basemap/assets/fonts/Noto Sans Regular/0-255.pbf").exists()


def _grid_pbf(tmp_path):
    import osmium

    from pipeline.fixtures import grid_osm

    xml = tmp_path / "grid.osm"
    xml.write_text(grid_osm())
    grid = tmp_path / "grid.osm.pbf"  # osmium picks the format from the extension
    with osmium.SimpleWriter(str(grid)) as writer:
        for obj in osmium.FileProcessor(str(xml)):
            writer.add(obj)
    return grid


def _fake_runner(grid, calls):
    """Stands in for curl and osmium: every file they'd write is the (tiny) grid extract."""
    import shutil

    def run(cmd):
        cmd = [str(c) for c in cmd]
        calls.append(cmd)
        if "-o" in cmd:
            shutil.copy(grid, cmd[cmd.index("-o") + 1])
    return run


def test_build_region_downloads_clips_and_builds(tmp_path):
    from pipeline import build_region
    from pipeline.pack import read_header

    calls: list[list[str]] = []
    pack = build_region.build_region(DALLAS, tmp_path / "work", tmp_path / "data",
                                     run=_fake_runner(_grid_pbf(tmp_path), calls))
    # roads and places filtered from the download; each cut out (the grid has no places: no index)
    assert [c[:2] for c in calls] == [["curl", "-fL"], ["osmium", "tags-filter"], ["osmium", "tags-filter"],
                                      ["osmium", "extract"], ["osmium", "extract"]]
    assert "nw/addr:housenumber" in calls[2] and "smart" in calls[4]
    assert calls[0][-1] == "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf"
    assert ("w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,"
            "tertiary,tertiary_link,unclassified,residential,living_street,service") in calls[1]
    assert "r/type=restriction" in calls[1] and "complete_ways" in calls[3]
    assert calls[3][2:4] == calls[4][2:4] == ["-b", "-97.05,32.63,-96.53,32.94"]
    assert pack == tmp_path / "data" / "packs" / "dallas.fwr" and read_header(pack)["counts"]["edges"] == 78
    assert not (tmp_path / "work" / "src" / "north-america_us_texas.osm.pbf").exists()  # raw download freed


def test_build_region_with_a_local_extract_skips_download_and_clip(tmp_path):
    from pipeline import build_region
    from pipeline.fixtures import grid_osm

    grid = tmp_path / "grid.osm"
    grid.write_text(grid_osm())
    calls: list = []
    pack = build_region.build_region(DALLAS, tmp_path / "w", tmp_path / "d", pbf=grid, run=calls.append)
    assert calls == [] and pack.exists()


def test_a_batch_downloads_each_state_once_merges_and_survives_a_bad_region(tmp_path, monkeypatch):
    from pipeline import build_batch

    a = Region("a", "A", (0, 0, 1, 1), ("north-america/us/north-carolina", "north-america/us/south-carolina"))
    b = Region("b", "B", (1, 1, 2, 2), ("north-america/us/north-carolina",))
    big = Region("big", "Big", (2, 2, 3, 3), ("north-america/us/north-carolina",))
    real = build_batch.build_pack.main

    def build(argv):  # the grid has 78 edges: a cap of 50 makes region "big" too big for a phone
        monkeypatch.setattr(build_batch, "MAX_EDGES", 50 if "big.osm.pbf" in argv[0] else 100)
        real(argv)

    monkeypatch.setattr(build_batch.build_pack, "main", build)
    calls: list[list[str]] = []
    report = build_batch.build_batch([a, b, big], tmp_path / "work", tmp_path / "data",
                                     run=_fake_runner(_grid_pbf(tmp_path), calls), basemaps=False, decider=None)
    downloads = [c[-1] for c in calls if c[0] == "curl"]
    assert downloads == ["https://download.geofabrik.de/north-america/us/north-carolina-latest.osm.pbf",
                         "https://download.geofabrik.de/north-america/us/south-carolina-latest.osm.pbf"]
    # each state filtered once, merged once, then one cut per region
    # each state filtered once (roads, then places), merged once, then cut per region (roads, then
    # places; the region that failed gets no search index)
    assert [c[1] for c in calls if c[0] == "osmium"] == ["tags-filter"] * 4 + ["merge"] * 2 + ["extract"] * 5
    assert [(r["id"], r["ok"]) for r in report] == [("a", True), ("b", True), ("big", False)]
    assert "too big for a phone" in report[2]["error"] and not (tmp_path / "data" / "packs" / "big.fwr").exists()
    assert report[0]["edges"] == 78 and report[0]["pack_bytes"] > 0


def test_plan_groups_regions_by_home_state_batch():
    from pipeline.plan import plan

    regions = [
        Region("charlotte", "Charlotte", (0, 0, 1, 1),
               ("north-america/us/north-carolina", "north-america/us/south-carolina")),
        Region("atlanta", "Atlanta", (0, 0, 1, 1), ("north-america/us/georgia",)),
        Region("dallas", "Dallas", (0, 0, 1, 1), ("north-america/us/texas",)),
    ]
    batches = plan(regions)
    assert batches[0] == {"batch": "southeast", "regions": ["charlotte", "atlanta"], "sources": [
        "north-america/us/north-carolina", "north-america/us/south-carolina", "north-america/us/georgia"]}
    assert batches[1]["batch"] == "south-central" and batches[1]["regions"] == ["dallas"]
    assert plan(regions, "dallas") == [batches[1]]
    with pytest.raises(KeyError):
        plan(regions, "nowhere")


def test_prune_deletes_what_no_manifest_has_named_for_a_day():
    import datetime as dt

    from pipeline.prune import parse_listing, stale_keys

    manifest = {"generated_at": "2026-10-01T00:00:00+00:00", "regions": [_entry("a")]}
    previous = {"generated_at": "2026-09-01T00:00:00+00:00", "regions": [_entry("a", "old")]}
    listing = parse_listing("\n".join([
        "packs/a.new.fwr.gz\t2026-10-01T00:00:00.000Z",
        "packs/a.old.fwr.gz\t2026-09-01T00:00:00.000Z",
        "basemap/a.new.pmtiles\t2026-10-01T00:00:00.000Z",
        "basemap/a.old.pmtiles\t2026-09-01T00:00:00.000Z",
        "packs/a.older.fwr.gz\t2026-08-01T00:00:00.000Z",  # named by neither manifest
        "basemap/assets/fonts/x.pbf\t2026-01-01T00:00:00.000Z",
        "packs/b.uploading.fwr.gz\t2026-10-01T23:30:00.000Z",  # a build that hasn't published yet
        "packs/c.untimed.fwr.gz",
        "cameras/a.json\t2026-01-01T00:00:00.000Z",
        "regions.json\t2026-01-01T00:00:00.000Z",
        "None",
    ]))
    soon = dt.datetime(2026, 10, 1, 12, tzinfo=dt.UTC)
    later = dt.datetime(2026, 10, 2, 1, tzinfo=dt.UTC)
    # Half a day after the switch the previous manifest's files are still in their grace day.
    assert stale_keys(manifest, listing, now=soon, min_age_hours=24, previous=previous) == ["packs/a.older.fwr.gz"]
    # A day on they go too; the live files, the fonts, a fresh upload and a file of unknown age stay.
    assert stale_keys(manifest, listing, now=later, min_age_hours=24, previous=previous) == [
        "basemap/a.old.pmtiles", "packs/a.old.fwr.gz", "packs/a.older.fwr.gz"]
    # Without the previous manifest there's no grace to give.
    assert "packs/a.old.fwr.gz" in stale_keys(manifest, listing, now=soon, min_age_hours=24)


def test_report_puts_failures_first_and_totals_the_bucket(tmp_path):
    from pipeline.report import render

    reports = [{"batch": "x", "regions": [
        {"id": "a", "name": "A", "batch": "x", "ok": True, "edges": 900_000, "pack_bytes": 30e6,
         "basemap_bytes": 80e6, "seconds": 61.0, "warning": "900,000 road edges is on the heavy side"},
        {"id": "b", "name": "B", "batch": "x", "ok": False, "error": "RuntimeError: boom", "seconds": 1.0},
        {"id": "c", "name": "C", "batch": "x", "ok": True, "edges": 10, "places_error": "ValueError: no streets"},
    ]}]
    (tmp_path / "cameras").mkdir()
    (tmp_path / "cameras" / "a.json").write_text(json.dumps({"cameras": [{}, {}, {}]}))
    entry = _entry("a") | {"name": "A", "pack": {"path": "p", "bytes": 18e6, "edges": 900_000},
                           "basemap": {"path": "q", "bytes": 80e6, "maxzoom": 15}, "places": {"path": "s", "bytes": 4e6}}
    md = render(reports, {"regions": [entry]}, tmp_path)
    assert "2 of 3 regions built" in md and "0.10 GB" in md and "**b** (x): RuntimeError: boom" in md
    assert "(1 with search)" in md and "0.004 GB search" not in md and "0.00 GB search indexes" in md
    assert "**c**: ValueError: no streets" in md
    table = md[md.index("| Region"):].splitlines()
    assert table[2].startswith("| B ❌") and table[3].startswith("| A |")
    assert "| 3 |" in table[3] and "(z15)" in table[3] and "| 4.0 |" in table[3]


def test_check_regions_finds_states_a_region_reaches_into():
    from shapely.geometry import box

    from pipeline.check_regions import check_region, parse_poly

    poly = parse_poly("nc\n1\n  -84.0 34.0\n  -80.0 34.0\n  -80.0 36.0\n  -84.0 36.0\nEND\n!2\n"
                      "  -83.0 35.0\n  -82.9 35.0\n  -82.9 35.1\nEND\nEND\n")
    assert 7.99 < poly.area < 8.0  # the square minus the little hole
    polys = {"north-america/us/north-carolina": box(-84, 35, -80, 36.6),
             "north-america/us/south-carolina": box(-83, 32, -78, 35.02),
             "north-america/us/georgia": box(-86, 30, -82.5, 35)}
    nc_only = Region("charlotte", "Charlotte", (-81.27, 34.87, -80.5, 35.62), ("north-america/us/north-carolina",))
    errors, _ = check_region(nc_only, polys)
    assert errors and "south-carolina" in errors[0]
    fixed = Region("charlotte", "Charlotte", (-81.27, 34.87, -80.5, 35.62),
                   ("north-america/us/north-carolina", "north-america/us/south-carolina", "north-america/us/georgia"))
    errors, notes = check_region(fixed, polys)
    assert errors == [] and len(notes) == 1 and "georgia" in notes[0]  # listed but never reached


def test_nothing_to_release_is_an_error(tmp_path):
    (tmp_path / "data").mkdir()
    with pytest.raises(RuntimeError, match="nothing to release"):
        stage_release(tmp_path / "data", tmp_path / "release", [DALLAS])
