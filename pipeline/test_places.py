"""The place index the app searches: what goes in, how it's filed, and the file format."""

import math

import numpy as np
import pytest

from pipeline.fixtures import BLOCK_M, GRID_LAT0, GRID_LON0, town_osm
from pipeline.osm_graph import EARTH_RADIUS_M
from pipeline.places import (
    FILE_SCALE, build_index, entries, fingerprint, kind_of, loose_keys, places_filter_command, plausible_street,
    read_header, sections, street_key, write_index,
)

DLAT = BLOCK_M / (math.radians(1.0) * EARTH_RADIUS_M)
DLON = DLAT / math.cos(math.radians(GRID_LAT0))


def at(r: float, c: float) -> tuple[float, float]:
    """Where the fixture puts grid row r, column c."""
    return GRID_LON0 + (c - 2) * DLON, GRID_LAT0 + (r - 2) * DLAT


@pytest.fixture(scope="module")
def town(tmp_path_factory):
    d = tmp_path_factory.mktemp("town")
    (d / "town.osm").write_text(town_osm())
    ix = build_index(d / "town.osm")
    write_index(d / "town.fwp", ix, built_at="2026-10-06T00:00:00+00:00", osm_at="2026-10-05T20:00:00Z")
    return d / "town.fwp", ix, entries(d / "town.fwp")


def test_streets_are_named_roads_grouped_by_distance(town):
    _, _, e = town
    streets = {(s["name"], s["town"]) for s in e["streets"]}
    # Main Street's two pieces are one street; Eastville's, 5 km away, is another; the footway isn't one.
    assert streets == {("Main Street", "Gridville"), ("Main Street", "Eastville"), ("Elm Street", "Gridville"),
                       ("North Oak Avenue", "Gridville"), ("Mill Road", "Gridville"), ("Hidden Lane", "Gridville")}
    main = next(s for s in e["streets"] if s["town"] == "Gridville" and s["name"] == "Main Street")
    lon0, lat0 = at(2, 0)
    lon1, lat1 = at(2, 4)
    assert all(lon0 - 1e-5 <= x <= lon1 + 1e-5 and abs(y - lat0) < 1e-5 for x, y in main["points"])  # on the street


def test_house_numbers_are_filed_under_their_street_however_written(town):
    _, _, e = town
    numbers = {(s["name"], s["town"]): [a[0] for a in s["addresses"]] for s in e["streets"]}
    # Sorted by number; 102 is a point and a building, kept once; 104B keeps its letter.
    assert numbers[("Main Street", "Gridville")] == ["100", "102", "104", "104B", "106", "110"]
    assert numbers[("Main Street", "Eastville")] == ["100"]
    # "N Oak Ave" and "N. Oak Ave." are North Oak Avenue; so is "Oak Avenue" (no direction) nearby.
    assert numbers[("North Oak Avenue", "Gridville")] == ["5", "7", "9"]
    assert numbers[("Elm Street", "Gridville")] == ["1"]  # "ELM": no type, in capitals
    assert numbers[("Mill Road", "Gridville")] == ["20", "22"]  # "20;22"
    assert numbers[("Hidden Lane", "Gridville")] == ["1", "3"]  # no road: a street of its own
    assert all("Fake" not in s["name"] for s in e["streets"])  # a whole address as a street name is dropped


def test_address_coordinates_survive_the_round_trip(town):
    _, _, e = town
    main = next(s for s in e["streets"] if s["town"] == "Gridville" and s["name"] == "Main Street")
    got = {n: (x, y) for n, x, y in main["addresses"]}
    for number, c in [("100", 0.5), ("106", 2.5), ("110", 3.5)]:
        lon, lat = at(1.9, c)
        assert abs(got[number][0] - lon) <= 1 / FILE_SCALE and abs(got[number][1] - lat) <= 1 / FILE_SCALE


def test_places_are_named_destinations_kept_once(town):
    _, _, e = town
    places = {(p["name"], p["kind"], p["town"]) for p in e["places"]}
    assert places == {
        ("Bean There", "Café", "Gridville"),  # addr:city "GRIDVILLE", tidied
        ("Bean There", "Restaurant", "Eastville"),  # the nearest town
        ("Grid Grocer", "Grocery store", "Gridville"),  # a point and its building: once
        ("Shell", "Gas station", "Gridville"),  # no name: the brand stands in
        ("QT", "Convenience store", "Gridville"),
        ("Mirror Lake", "Lake", "Gridville"),
        ("Gridville Regional Airport", "Airport", "Gridville"),  # a multipolygon relation
        ("Gridville", "Town", None), ("Eastville", "Town", None),  # a town isn't in itself
        ("Smallville", "Village", None), ("Old Town", "Neighborhood", "Gridville"),
    }
    airport = next(p for p in e["places"] if p["kind"] == "Airport")
    assert airport["alt"] == "GRV" and airport["rank"] == 3  # an airline code: a real airport
    lon, lat = at(0, 3.5)
    assert abs(airport["lon"] - lon) < 2e-5 and abs(airport["lat"] - lat) < 2e-5  # the middle of its outline
    assert next(p for p in e["places"] if p["name"] == "QT")["alt"] == "QuikTrip"


def test_the_header_and_stats(town):
    path, ix, _ = town
    h = read_header(path)
    assert h["format"] == "avoidlpr-places" and h["coord_scale"] == FILE_SCALE
    assert h["counts"] == {"streets": 6, "addresses": 15, "places": 11}
    assert h["osm_at"] == "2026-10-05T20:00:00Z" and len(h["fingerprint"]) == 16
    assert h["stats"]["addresses_matched_loosely"] == 2 and h["stats"]["addresses_without_a_street"] == 1
    assert all(s["offset"] % 8 == 0 for s in h["sections"])
    w, s_, e_, n = h["bbox"]
    assert w < GRID_LON0 < e_ and s_ < GRID_LAT0 < n


def test_the_same_data_makes_the_same_file(town, tmp_path):
    path, ix, _ = town
    (tmp_path / "town.osm").write_text(town_osm())
    again = build_index(tmp_path / "town.osm")
    assert fingerprint(again, sections(again)) == fingerprint(ix, sections(ix))
    write_index(tmp_path / "a.fwp", again, built_at="2026-10-06T00:00:00+00:00", osm_at="2026-10-05T20:00:00Z")
    assert (tmp_path / "a.fwp").read_bytes() == path.read_bytes()
    write_index(tmp_path / "b.fwp", again, built_at="2026-11-03T00:00:00+00:00")  # rebuilt next month
    assert read_header(tmp_path / "b.fwp")["fingerprint"] == read_header(path)["fingerprint"]


def test_street_keys_spell_abbreviations_one_way():
    assert street_key("East Belt Line Road") == street_key("E Belt Line Rd") == "e belt line rd"
    assert street_key("N. Oak Ave.") == street_key("North Oak Avenue")
    assert street_key("Saint Augustine  Road") == street_key("St Augustine Rd")
    assert loose_keys("e belt line rd") == ("belt line rd", "belt line")
    assert loose_keys("abrams rd") == ("abrams rd", "abrams")
    assert loose_keys("n main st sw") == ("main st", "main")
    assert loose_keys("broadway") == ("broadway", "broadway")


def test_plausible_street_names():
    assert plausible_street("2nd Avenue") and plausible_street("Elm") and plausible_street("Calle 8")
    assert not plausible_street("4626") and not plausible_street("5431,5433")
    assert not plausible_street("1050 N Westmoreland Rd") and not plausible_street("12 Fake Street, Gridville")


@pytest.mark.parametrize(("tags", "kind"), [
    ({"amenity": "fuel"}, ("Gas station", 1)),
    ({"amenity": "bench"}, None),
    ({"shop": "yes"}, ("Shop", 1)),
    ({"shop": "Nail Salon"}, ("Shop", 1)),  # not a plain tag value
    ({"aeroway": "aerodrome"}, ("Airport", 1)),
    ({"aeroway": "aerodrome", "iata": "CLT"}, ("Airport", 3)),
    ({"natural": "water"}, ("Lake", 1)),
    ({"natural": "water", "water": "river"}, None),
    ({"railway": "station"}, ("Station", 2)),
    ({"railway": "rail"}, None),
    ({"highway": "bus_stop"}, None),
    ({"addr:housenumber": "12"}, ("Place", 0)),
    ({"building": "yes"}, ("Building", 0)),
    ({"place": "suburb"}, ("Neighborhood", 2)),
])
def test_kind_of(tags, kind):
    assert kind_of(tags) == kind


def test_the_filter_keeps_names_addresses_and_place_outlines():
    cmd = places_filter_command("state.osm.pbf", "places.osm.pbf")
    assert cmd[:3] == ["osmium", "tags-filter", "state.osm.pbf"] and cmd[-2:] == ["-o", "places.osm.pbf"]
    assert {"nw/name", "nw/brand", "nw/addr:housenumber", "r/aeroway", "r/shop"} <= set(cmd)


def test_an_extract_with_nothing_to_find_is_an_error(tmp_path):
    (tmp_path / "empty.osm").write_text('<?xml version="1.0"?><osm version="0.6"></osm>\n')
    with pytest.raises(ValueError, match="no streets"):
        build_index(tmp_path / "empty.osm")


def test_deltas_restart_on_each_street(town):
    path, ix, _ = town
    from pipeline.places import read_index

    _, a = read_index(path)
    ptr = a["street_addr_ptr"].astype(np.int64)
    for i in range(len(ptr) - 1):
        steps = a["addr_num"][ptr[i]:ptr[i + 1]]
        assert (steps[1:] >= 0).all()  # numbers only rise along a street


# ---- in the build: made monthly, staged, kept when unchanged, cleaned up when replaced

def _pbf(tmp_path, name, xml_text):
    import osmium

    xml = tmp_path / f"{name}.osm"
    xml.write_text(xml_text)
    pbf = tmp_path / f"{name}.osm.pbf"  # osmium picks the format from the extension
    with osmium.SimpleWriter(str(pbf)) as writer:
        for obj in osmium.FileProcessor(str(xml)):
            writer.add(obj)
    return pbf


def _runner(tmp_path, calls):
    """Stands in for curl and osmium: road files are the grid, places files the town."""
    import shutil

    from pipeline.fixtures import grid_osm

    grid, town = _pbf(tmp_path, "grid", grid_osm()), _pbf(tmp_path, "town", town_osm())

    def run(cmd):
        cmd = [str(c) for c in cmd]
        calls.append(cmd)
        if "-o" in cmd:
            target = cmd[cmd.index("-o") + 1]
            shutil.copy(town if "places" in target else grid, target)
    return run


def _region(rid="gridville"):
    from pipeline.regions import Region

    return Region(rid, "Gridville", (-96.81, 32.77, -96.79, 32.79), ("north-america/us/texas",))


def test_the_monthly_build_makes_each_region_a_search_index(tmp_path):
    from pipeline import build_batch

    calls: list[list[str]] = []
    report = build_batch.build_batch([_region()], tmp_path / "work", tmp_path / "data", run=_runner(tmp_path, calls),
                                     basemaps=False, decider=None, now=dt_now())
    assert report[0]["ok"] and report[0]["places"] == {"streets": 6, "addresses": 15, "places": 11}
    index = tmp_path / "data" / "places" / "gridville.fwp"
    assert report[0]["places_bytes"] == index.stat().st_size
    assert read_header(index)["built_at"] == "2026-10-06T06:00:00+00:00"
    assert not list((tmp_path / "work" / "regions").glob("*.places.osm.pbf"))  # the cut is cleaned up


def test_the_nightly_update_leaves_the_search_index_alone(tmp_path):
    from pipeline import build_batch

    calls: list[list[str]] = []
    run = _runner(tmp_path, calls)

    def updater(path, work, run_, rewind=0):
        from pipeline import roads

        return roads.fresh(path, work, run_), True  # a first night: no cached roads

    report = build_batch.build_batch([_region()], tmp_path / "work", tmp_path / "data", run=run, mode="roads",
                                     basemaps=False, decider=None, updater=updater, now=dt_now())
    assert report[0]["ok"] and "places" not in report[0]
    assert not (tmp_path / "data" / "places").exists()
    assert not any("nw/addr:housenumber" in c for c in calls)


def dt_now():
    import datetime as dt

    return dt.datetime(2026, 10, 6, 6, tzinfo=dt.UTC)


def test_staging_lists_the_search_index_and_keeps_an_unchanged_one(tmp_path, town):
    import gzip
    import shutil

    from pipeline.release import HASH_CHARS, sha256_of, stage_places

    path, _, _ = town
    data, out = tmp_path / "data", tmp_path / "release"
    (data / "places").mkdir(parents=True)
    shutil.copy(path, data / "places" / "gridville.fwp")
    entry = stage_places(_region(), data, out)
    staged = out / entry["path"]
    assert staged.name == f"gridville.{sha256_of(staged)[:HASH_CHARS]}.fwp.gz" and entry["encoding"] == "gzip"
    assert gzip.decompress(staged.read_bytes()) == path.read_bytes()
    assert entry["counts"] == {"streets": 6, "addresses": 15, "places": 11} and entry["osm_at"] == "2026-10-05T20:00:00Z"
    assert entry["raw_bytes"] == path.stat().st_size and entry["sha256"] == sha256_of(staged)

    live = {"places": {**entry, "path": "places/gridville.0123456789.fwp.gz"}}
    assert stage_places(_region(), data, tmp_path / "again", live)["path"] == live["places"]["path"]  # same contents
    (data / "places" / "gridville.fwp").unlink()
    assert stage_places(_region(), data, out, live) == live["places"]  # nothing built (the nightly): the live one
    assert stage_places(_region(), data, out) is None  # nothing at all: the area has no search yet


def test_the_manifest_entry_carries_the_search_index(tmp_path, town):
    import shutil

    from pipeline.fixtures import grid_osm
    from pipeline.osm_graph import build_graph
    from pipeline.pack import pack_meta, pack_sections, write_pack
    from pipeline.release import stage_region

    path, _, _ = town
    data = tmp_path / "data"
    (data / "places").mkdir(parents=True)
    (data / "basemap").mkdir()
    (data / "packs").mkdir()
    (tmp_path / "grid.osm").write_text(grid_osm())
    g = build_graph(tmp_path / "grid.osm")
    write_pack(data / "packs" / "gridville.fwr", pack_meta(g, "grid.osm", "test"), pack_sections(g))
    (data / "basemap" / "gridville.pmtiles").write_bytes(b"PMTiles" + bytes(range(200)))
    assert "places" not in stage_region(_region(), data, tmp_path / "release")  # optional
    shutil.copy(path, data / "places" / "gridville.fwp")
    entry = stage_region(_region(), data, tmp_path / "release")
    assert entry["places"]["path"].startswith("places/gridville.")


def test_prune_keeps_the_search_indexes_the_manifests_name():
    import datetime as dt

    from pipeline.prune import stale_keys

    now = dt.datetime(2026, 10, 10, tzinfo=dt.UTC)
    old = now - dt.timedelta(days=3)
    region = {"pack": {"path": "packs/a.1.fwr.gz"}, "basemap": {"path": "basemap/a.1.pmtiles"},
              "places": {"path": "places/a.1.fwp.gz"}}
    bare = {"pack": {"path": "packs/b.1.fwr.gz"}, "basemap": {"path": "basemap/b.1.pmtiles"}}  # no search yet
    manifest = {"generated_at": (now - dt.timedelta(days=2)).isoformat(), "regions": [region, bare]}
    objects = {k: old for k in ("packs/a.1.fwr.gz", "places/a.1.fwp.gz", "places/a.0.fwp.gz", "basemap/a.1.pmtiles",
                                "packs/b.1.fwr.gz", "basemap/b.1.pmtiles")}
    assert stale_keys(manifest, objects, now=now, min_age_hours=24) == ["places/a.0.fwp.gz"]
