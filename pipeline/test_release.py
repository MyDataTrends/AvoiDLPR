import json

import pytest

from pipeline import deflock, refresh_cameras
from pipeline.pack import pack_meta, pack_sections, write_pack
from pipeline.regions import Region, get_region, load_regions
from pipeline.release import HASH_CHARS, sha256_of, stage_release

DALLAS = Region("dallas", "Dallas", (-97.05, 32.63, -96.53, 32.94), "north-america/us/texas",
                ((-96.85692, 32.73077), (-96.66394, 32.85072)))


def test_shipped_regions_are_valid():
    regions = load_regions()
    assert {r.id for r in regions} >= {"dallas"}
    assert get_region("dallas").geofabrik_url.endswith("/north-america/us/texas-latest.osm.pbf")


def test_bad_regions_are_rejected(tmp_path):
    cfg = tmp_path / "r.json"
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [1, 2, 0, 3], "geofabrik": "x"}]}))
    with pytest.raises(ValueError, match="invalid clip_bbox"):
        load_regions(cfg)
    cfg.write_text(json.dumps({"regions": [{"id": "a", "name": "A", "clip_bbox": [0, 0, 1, 1], "geofabrik": "x"}] * 2}))
    with pytest.raises(ValueError, match="duplicate"):
        load_regions(cfg)


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
    out = tmp_path / "release"
    manifest = stage_release(data_dir, out, [DALLAS, Region("elsewhere", "Elsewhere", (0, 0, 1, 1), "x")])
    assert [r["id"] for r in manifest["regions"]] == ["dallas"]  # the region without data is skipped
    r = manifest["regions"][0]
    pack = out / r["pack"]["path"]
    assert pack.name == f"dallas.{sha256_of(data_dir / 'packs' / 'dallas.fwr')[:HASH_CHARS]}.fwr"
    assert pack.read_bytes() == (data_dir / "packs" / "dallas.fwr").read_bytes()
    assert r["pack"]["sha256"] == sha256_of(pack) and r["pack"]["bytes"] == pack.stat().st_size
    assert (out / r["basemap"]["path"]).read_bytes().startswith(b"PMTiles")
    assert json.loads((out / r["cameras"]["path"]).read_text()) == {"cameras": [{"id": 1}]}
    assert (out / "basemap/assets/fonts/Noto Sans Regular/0-255.pbf").read_bytes() == b"glyphs"
    assert manifest["assets"]["sprite"] == "basemap/assets/sprites/v4/light"
    assert len(r["bbox"]) == 4 and len(r["center"]) == 2
    assert r["example"] == {"from": [-96.85692, 32.73077], "to": [-96.66394, 32.85072]}
    assert json.loads((out / "regions.json").read_text()) == manifest


def test_restaging_replaces_old_versions_and_keeps_a_fresher_feed(data_dir, tmp_path):
    out = tmp_path / "release"
    first = stage_release(data_dir, out, [DALLAS])["regions"][0]["pack"]["path"]
    (out / "cameras" / "dallas.json").write_text(json.dumps({"cameras": [{"id": 1}, {"id": 2}]}))  # an hourly refresh
    (data_dir / "basemap" / "dallas.pmtiles").write_bytes(b"PMTiles-v2")
    second = stage_release(data_dir, out, [DALLAS])
    assert second["regions"][0]["pack"]["path"] == first  # unchanged pack, same name
    assert len(list((out / "basemap").glob("dallas.*.pmtiles"))) == 1  # the old basemap is gone
    assert len(json.loads((out / "cameras" / "dallas.json").read_text())["cameras"]) == 2  # refresh kept


def test_build_region_downloads_clips_and_builds(tmp_path):
    from pipeline import build_region
    from pipeline.fixtures import grid_osm
    from pipeline.pack import read_header

    import osmium

    xml = tmp_path / "grid.osm"
    xml.write_text(grid_osm())
    grid = tmp_path / "grid.osm.pbf"  # osmium picks the format from the extension
    with osmium.SimpleWriter(str(grid)) as writer:
        for obj in osmium.FileProcessor(str(xml)):
            writer.add(obj)
    calls: list[list[str]] = []

    def fake(cmd):
        calls.append([str(c) for c in cmd])
        out = cmd[cmd.index("-o") + 1] if "-o" in cmd else None
        if out:  # pretend the download / clip produced the (tiny) extract
            import shutil
            shutil.copy(grid, out)

    pack = build_region.build_region(DALLAS, tmp_path / "work", tmp_path / "data", run=fake)
    assert [c[0] for c in calls] == ["curl", "osmium"]
    assert calls[0][-1] == "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf"
    assert calls[1][:5] == ["osmium", "extract", "-b", "-97.05,32.63,-96.53,32.94", "--strategy"]
    assert "complete_ways" in calls[1]
    assert pack == tmp_path / "data" / "packs" / "dallas.fwr" and read_header(pack)["counts"]["edges"] == 78


def test_build_region_with_a_local_extract_skips_download_and_clip(tmp_path):
    from pipeline import build_region
    from pipeline.fixtures import grid_osm

    grid = tmp_path / "grid.osm"
    grid.write_text(grid_osm())
    calls: list = []
    pack = build_region.build_region(DALLAS, tmp_path / "w", tmp_path / "d", pbf=grid, clip=False, run=calls.append)
    assert calls == [] and pack.exists()


def test_nothing_to_release_is_an_error(tmp_path):
    (tmp_path / "data").mkdir()
    with pytest.raises(RuntimeError, match="nothing to release"):
        stage_release(tmp_path / "data", tmp_path / "release", [DALLAS])
