"""The nightly road updates: rolling a state's roads forward, deciding what to publish, and staging
only what changed."""

import datetime as dt
import json
import shutil
import types
from pathlib import Path

import osmium
import pytest

from pipeline import build_batch, roads
from pipeline.decide import MIN_DAYS_BETWEEN_UPDATES, SIGNIFICANT_CHANGE, decide
from pipeline.fixtures import grid_osm
from pipeline.osm_graph import build_graph
from pipeline.pack import pack_meta, pack_sections, read_header, write_pack
from pipeline.regions import Region
from pipeline.release import SCHEMA, same_manifest, stage_region

NC = "north-america/us/north-carolina"
SC = "north-america/us/south-carolina"
CHARLOTTE = Region("charlotte", "Charlotte", (-81.27, 34.87, -80.5, 35.62), (NC, SC))
NOW = dt.datetime(2026, 10, 10, 12, tzinfo=dt.UTC)


def write_pbf(path, *, sequence=None, timestamp="2026-10-05T20:00:00Z", server="https://example/nc-updates"):
    """The grid as a PBF, with Geofabrik-style replication headers when `sequence` is given."""
    xml = path.with_suffix(".xml")
    xml.write_text(grid_osm())
    header = osmium.io.Header()
    if sequence is not None:
        header.set("osmosis_replication_sequence_number", str(sequence))
        header.set("osmosis_replication_timestamp", timestamp)
        header.set("osmosis_replication_base_url", server)
    with osmium.SimpleWriter(str(path), 0, header) as w:
        for obj in osmium.FileProcessor(str(xml)):
            w.add(obj)
    xml.unlink()
    return path


def copying_runner(calls):
    """Stand-ins for curl (a fresh extract at sequence 4000) and osmium tags-filter (a copy)."""
    def run(cmd):
        cmd = [str(c) for c in cmd]
        calls.append(cmd)
        target = Path(cmd[cmd.index("-o") + 1])
        if cmd[0] == "curl":
            write_pbf(target, sequence=4000)
        else:  # osmium tags-filter SOURCE <expressions> --overwrite -o TARGET
            shutil.copy(cmd[2], target)
    return run


class FakeServer:
    """A replication server that has reached `latest`: applying changes re-stamps the file."""

    def __init__(self, latest, *, gone=False):
        self.latest, self.gone, self.applied = latest, gone, []

    def __call__(self, url):
        self.url = url
        return self

    def get_state_info(self, seq=None):
        return types.SimpleNamespace(sequence=self.latest, timestamp=dt.datetime(2026, 10, 9, 20, tzinfo=dt.UTC))

    def apply_diffs_to_file(self, infile, outfile, start_id, max_size=None):
        self.applied.append(start_id)
        if self.gone:
            return None
        write_pbf(Path(outfile), sequence=self.latest, timestamp="2026-10-09T20:00:00Z", server=self.url)
        return (self.latest, self.latest)


# ---------- rolling a state forward ----------

def test_fresh_records_where_the_extract_stands(tmp_path):
    calls = []
    state = roads.fresh(NC, tmp_path, copying_runner(calls))
    assert [c[0:2] for c in calls] == [["curl", "-fL"], ["osmium", "tags-filter"]]
    assert state == {"server": "https://example/nc-updates", "sequence": 4000, "timestamp": "2026-10-05T20:00:00Z"}
    assert json.loads(roads.state_file(tmp_path, NC).read_text()) == state
    assert roads.roads_file(tmp_path, NC).exists() and not (tmp_path / "src" / f"{roads.slug(NC)}.osm.pbf").exists()


def test_update_applies_the_changes_since_and_filters_again(tmp_path):
    calls = []
    roads.fresh(NC, tmp_path, copying_runner(calls))
    server = FakeServer(4003)
    state, changed = roads.update(NC, tmp_path, copying_runner(calls), server=server)
    assert changed and server.applied == [4001]  # straight after the change it already holds
    assert state["sequence"] == 4003 and state["timestamp"] == "2026-10-09T20:00:00Z"
    assert calls[-1][1] == "tags-filter"  # the day's buildings and paths are filtered back out
    assert not any(p.name.endswith(".updated.osm.pbf") for p in (tmp_path / "roads").iterdir())
    again = roads.update(NC, tmp_path, copying_runner(calls), server=FakeServer(4003))
    assert again == (state, False)  # nothing new: nothing done


def test_rewinding_re_applies_the_latest_changes(tmp_path):
    calls = []
    roads.fresh(NC, tmp_path, copying_runner(calls))
    server = FakeServer(4000)  # nothing new since the download
    assert roads.update(NC, tmp_path, copying_runner(calls), server=server)[1] is False
    state, changed = roads.update(NC, tmp_path, copying_runner(calls), server=server, rewind=2)
    assert changed and server.applied == [3999] and state["sequence"] == 4000


def test_update_without_a_copy_or_with_changes_gone_starts_fresh(tmp_path):
    calls = []
    state, changed = roads.update(NC, tmp_path, copying_runner(calls), server=FakeServer(4003))
    assert changed and calls[0][0] == "curl" and state["sequence"] == 4000
    calls.clear()
    state, _ = roads.update(NC, tmp_path, copying_runner(calls), server=FakeServer(4500, gone=True))
    assert calls[0][0] == "curl"  # the server no longer has the changes from 4001: download again


# ---------- what to publish ----------

def grid_pack(tmp_path, name="new.fwr", built_at="2026-10-10T07:00:00+00:00"):
    xml = tmp_path / "g.osm"
    xml.write_text(grid_osm())
    g = build_graph(xml)
    path = tmp_path / name
    write_pack(path, pack_meta(g, "g.osm", built_at, "2026-10-09T20:00:00Z"), pack_sections(g))
    return path


def live_entry(pack, *, fingerprint=None, built_at="2026-10-08T07:00:00+00:00"):
    return {"id": "a", "bbox": [0, 0, 1, 1], "pack": {"path": "packs/a.live.fwr.gz", "built_at": built_at,
            "fingerprint": fingerprint or "something-else", "bytes": 1, "edges": 1},
            "basemap": {"path": "basemap/a.live.pmtiles", "bytes": 1}}


def verifier(**verdict):
    seen = []

    def verify(fresh, live):
        seen.append(live)
        return {"ok": True, "reasons": [], **verdict}
    verify.seen = seen
    return verify


def test_decide(tmp_path):
    pack = grid_pack(tmp_path)
    fp = read_header(pack)["fingerprint"]
    fetched = lambda path, dest: dest.write_bytes(b"live") or True  # noqa: E731

    same = decide("a", pack, live_entry(pack, fingerprint=fp), mode="roads", now=NOW, verify=verifier(), fetch_live=fetched)
    assert same.action == "unchanged"

    new = decide("a", pack, None, mode="roads", now=NOW, verify=(v := verifier()), fetch_live=fetched)
    assert new.action == "publish" and v.seen == [None]  # checked on its own

    bad = decide("a", pack, live_entry(pack), mode="roads", now=NOW, fetch_live=fetched,
                 verify=lambda f, l: {"ok": False, "reasons": ["the road edge count changed by −40%"]})
    assert bad.action == "hold" and "−40%" in bad.why

    small = SIGNIFICANT_CHANGE / 4
    recent = decide("a", pack, live_entry(pack), mode="roads", now=NOW, verify=(v := verifier(changed=small)),
                    fetch_live=fetched)
    assert recent.action == "defer" and v.seen[0].name == "a.live.fwr.gz" and not v.seen[0].exists()
    big = decide("a", pack, live_entry(pack), mode="roads", now=NOW, verify=verifier(changed=SIGNIFICANT_CHANGE),
                 fetch_live=fetched)
    assert big.action == "publish" and "1.0% of road edges changed" in big.why
    stale = live_entry(pack, built_at=(NOW - dt.timedelta(days=MIN_DAYS_BETWEEN_UPDATES)).isoformat())
    aged = decide("a", pack, stale, mode="roads", now=NOW, verify=verifier(changed=small), fetch_live=fetched)
    assert aged.action == "publish" and "days old" in aged.why
    monthly = decide("a", pack, live_entry(pack), mode="full", now=NOW, verify=verifier(changed=small), fetch_live=fetched)
    assert monthly.action == "publish"


# ---------- a nightly batch ----------

def test_a_nightly_batch_rolls_states_forward_and_publishes_only_what_should_go(tmp_path):
    grid = write_pbf(tmp_path / "grid.osm.pbf")
    calls = []

    def run(cmd):  # osmium writes the grid; the basemap script writes a stand-in archive
        cmd = [str(c) for c in cmd]
        calls.append(cmd)
        if "-o" in cmd:
            shutil.copy(grid, cmd[cmd.index("-o") + 1])
        if cmd[0] == "node":
            out = tmp_path / "data" / "basemap" / f"{cmd[cmd.index('--region') + 1]}.pmtiles"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"PMTiles")

    stamps = {NC: "2026-10-09T20:00:00Z", SC: "2026-10-09T21:00:00Z"}
    updater = lambda path, work, run, rewind=0: ({"timestamp": stamps[path]}, True)  # noqa: E731
    outcomes = {"a": "publish", "b": "defer", "c": "unchanged"}

    def decider(region_id, pack, live, *, mode, now):
        from pipeline.decide import Decision
        assert mode == "roads" and read_header(pack)["osm_at"] == "2026-10-09T20:00:00Z"  # the staler state
        return Decision(outcomes[region_id], "test")

    a = Region("a", "A", (0, 0, 1, 1), (NC, SC))
    b = Region("b", "B", (0, 0, 1, 1), (NC,))
    c = Region("c", "C", (0, 0, 1, 1), (NC,))
    live = {"regions": [{"id": "b"}, {"id": "c"}]}  # a is new: it alone needs a basemap
    report = build_batch.build_batch([a, b, c], tmp_path / "work", tmp_path / "data", run=run, mode="roads",
                                     live=live, decider=decider, updater=updater, basemap_build="20261009")
    assert [(r["id"], r["status"]) for r in report] == [("a", "publish"), ("b", "defer"), ("c", "unchanged")]
    assert not any(c[0] == "curl" for c in calls)  # nothing downloaded: the states were rolled forward
    assert sorted(p.name for p in (tmp_path / "data" / "packs").iterdir()) == ["a.fwr"]  # the rest stay live
    basemaps = [c for c in calls if c[0] == "node"]
    assert len(basemaps) == 1 and basemaps[0][basemaps[0].index("--region") + 1] == "a"


def test_the_monthly_build_refreshes_an_unchanged_areas_basemap(tmp_path):
    """The basemap script reads the pack's bounding box: an unchanged pack goes after it, not before."""
    grid = write_pbf(tmp_path / "grid.osm.pbf")
    pack = tmp_path / "data" / "packs" / "a.fwr"
    seen = []

    def run(cmd):  # curl brings a state, osmium writes the grid, the basemap script a stand-in
        cmd = [str(c) for c in cmd]
        if cmd[0] == "curl":
            write_pbf(Path(cmd[cmd.index("-o") + 1]), sequence=4000)
        elif "-o" in cmd:
            shutil.copy(grid, cmd[cmd.index("-o") + 1])
        if cmd[0] == "node":
            seen.append(pack.exists())
            out = tmp_path / "data" / "basemap" / "a.pmtiles"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"PMTiles")

    def decider(region_id, pack_, live, *, mode, now):
        from pipeline.decide import Decision
        return Decision("unchanged", "same roads as the live pack")

    a = Region("a", "A", (0, 0, 1, 1), (NC,))
    report = build_batch.build_batch([a], tmp_path / "work", tmp_path / "data", run=run, mode="full",
                                     live={"regions": [{"id": "a"}]}, decider=decider, basemap_build="20261103")
    assert report[0]["ok"] and report[0]["status"] == "unchanged" and report[0]["basemap_bytes"] == 7
    assert seen == [True]  # the pack was there for the basemap
    assert not pack.exists()  # and gone after it: staging keeps the live one


# ---------- staging only what changed ----------

def test_an_unchanged_pack_keeps_its_published_file(tmp_path):
    data, out = tmp_path / "data", tmp_path / "release"
    (data / "packs").mkdir(parents=True)
    pack = grid_pack(tmp_path, "x.fwr")
    shutil.copy(pack, data / "packs" / "a.fwr")
    region = Region("a", "A", (0, 0, 1, 1), (NC,))
    live = live_entry(pack, fingerprint=read_header(pack)["fingerprint"])

    same = stage_region(region, data, out, live)
    assert same["pack"] is live["pack"] and same["basemap"] is live["basemap"]  # no basemap built: the live one
    assert not (out / "packs").exists() or not list((out / "packs").iterdir())  # nothing new to upload

    changed = stage_region(region, data, out, live_entry(pack))
    assert changed["pack"]["path"].startswith("packs/a.") and changed["pack"]["fingerprint"] == live["pack"]["fingerprint"]
    assert changed["pack"]["osm_at"] == "2026-10-09T20:00:00Z"
    assert stage_region(Region("z", "Z", (0, 0, 1, 1), (NC,)), data, out) is None  # nothing built, nothing live


def test_a_manifest_that_lists_the_same_files_is_the_same():
    a = {"schema": SCHEMA, "generated_at": "2026-10-01T00:00:00+00:00", "regions": [{"id": "x"}]}
    assert same_manifest(a, {**a, "generated_at": "2026-10-02T00:00:00+00:00"})
    assert not same_manifest(a, {**a, "regions": [{"id": "y"}]})
    assert not same_manifest(a, None)


@pytest.mark.parametrize("built_at", ["2026-01-01T00:00:00+00:00", "2026-02-02T00:00:00+00:00"])
def test_a_rebuild_from_the_same_roads_has_the_same_fingerprint(tmp_path, built_at):
    first = read_header(grid_pack(tmp_path, "one.fwr"))["fingerprint"]
    assert read_header(grid_pack(tmp_path, "two.fwr", built_at))["fingerprint"] == first


def test_the_summary_tells_what_happened_to_each_area(tmp_path):
    from pipeline.report import render

    reports = [{"batch": "x", "mode": "roads", "regions": [
        {"id": "a", "name": "A", "batch": "x", "ok": True, "status": "publish", "changed": 0.023, "edges": 10},
        {"id": "b", "name": "B", "batch": "x", "ok": True, "status": "hold", "why": "sample trips take +40% as long",
         "edges": 10},
        {"id": "c", "name": "C", "batch": "x", "ok": True, "status": "unchanged", "edges": 10},
        {"id": "d", "name": "D", "batch": "x", "ok": True, "status": "defer", "changed": 0.002, "edges": 10},
    ]}]
    md = render(reports, None, tmp_path)
    assert md.startswith("## Nightly road update: 4 of 4 regions built (1 published, 1 unchanged, 1 deferred, 1 held back)")
    assert "- **b**: sample trips take +40% as long" in md
    table = md[md.index("| Region"):].splitlines()[2:]
    assert [line.split(" | ")[1] for line in table] == ["held back", "published (2.30% changed)", "deferred (0.20% changed)",
                                                       "unchanged"]
