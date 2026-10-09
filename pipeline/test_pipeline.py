import numpy as np
import pytest

from pipeline.fixtures import grid_nodes, grid_osm, guide_osm
from pipeline.osm_graph import COORD_SCALE, FLAG_ROUNDABOUT, LABEL_SEP, build_graph, road_label, turn_class
from pipeline.pack import (decode_labels, decode_vertices, fingerprint, pack_meta, pack_sections, read_pack,
                           write_pack)


@pytest.fixture(scope="module")
def grid(tmp_path_factory):
    path = tmp_path_factory.mktemp("grid") / "grid.osm"
    path.write_text(grid_osm())
    return build_graph(path)


def _osm_ids(g):
    """(src, dst) OSM node id per edge, matched through vertex coordinates."""
    by_coord = {(round(lon * COORD_SCALE), round(lat * COORD_SCALE)): nid
                for nid, (lon, lat) in grid_nodes().items()}
    first, last = g.geom_q[g.geom_ptr[:-1]], g.geom_q[g.geom_ptr[1:] - 1]
    ends = []
    for geom, rev in zip(g.edge_geom, g.edge_rev, strict=True):
        a, b = by_coord[tuple(first[geom])], by_coord[tuple(last[geom])]
        ends.append((b, a) if rev else (a, b))
    return ends


def _edge(g, src, dst):
    return _osm_ids(g).index((src, dst))


def test_grid_shape(grid):
    assert grid.n_nodes == 26  # 25 grid nodes + the dead-end stub; footway and island gone
    assert len(grid.geom_ptr) - 1 == 41
    assert len(grid.edge_src) == 78  # 37 two-way geometries + 4 one-way
    assert grid.stats["edges_dropped_outside_scc"] == 2
    assert np.all(np.diff(grid.edge_src) >= 0)  # numbered by source node


def test_one_way_row(grid):
    ids = _osm_ids(grid)
    assert (6, 7) in ids and (7, 6) not in ids


def test_restriction_bans_exactly_the_right_turn(grid):
    assert list(zip(grid.ban_from, grid.ban_to, strict=True)) == [(_edge(grid, 12, 17), _edge(grid, 17, 18))]


def test_signal_delays_edges_arriving_at_or_through_it(grid):
    free = 200 / (30 / 3.6)
    t = grid.edge_time
    assert t[_edge(grid, 13, 14)] == pytest.approx(free + 8, abs=0.05)
    assert t[_edge(grid, 15, 14)] == pytest.approx(free + 8, abs=0.05)
    assert t[_edge(grid, 14, 15)] == pytest.approx(free, abs=0.05)


def test_headings(grid):
    h0 = grid.edge_h0
    assert h0[_edge(grid, 1, 6)] == pytest.approx(0, abs=0.01)
    assert h0[_edge(grid, 6, 7)] == pytest.approx(90, abs=0.01)
    assert h0[_edge(grid, 6, 1)] == pytest.approx(180, abs=0.01)
    assert grid.edge_h1[_edge(grid, 2, 1)] == pytest.approx(270, abs=0.01)


def test_turn_class():
    assert turn_class(0, 90) == "right" and turn_class(0, 270) == "left"
    assert turn_class(350, 10) == "straight" and turn_class(90, 275) == "u"


def test_restriction_through_via_node_is_narrowed_to_the_named_turn(tmp_path):
    # A plain + intersection whose ways run straight through the via node. The relation
    # can't say which approach it means, so both right turns onto the to-way are banned
    # (a longer legal route beats an illegal turn), and nothing else.
    xml = """<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">
      <node id="1" version="1" lat="32.779" lon="-96.80"/><node id="2" version="1" lat="32.780" lon="-96.80"/>
      <node id="3" version="1" lat="32.781" lon="-96.80"/><node id="4" version="1" lat="32.780" lon="-96.801"/>
      <node id="5" version="1" lat="32.780" lon="-96.799"/>
      <way id="10" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/></way>
      <way id="20" version="1"><nd ref="4"/><nd ref="2"/><nd ref="5"/><tag k="highway" v="residential"/></way>
      <way id="30" version="1"><nd ref="3"/><nd ref="5"/><tag k="highway" v="residential"/></way>
      <way id="31" version="1"><nd ref="4"/><nd ref="1"/><tag k="highway" v="residential"/></way>
      <relation id="9" version="1"><member type="way" ref="10" role="from"/><member type="node" ref="2" role="via"/>
        <member type="way" ref="20" role="to"/><tag k="type" v="restriction"/><tag k="restriction" v="no_right_turn"/></relation>
    </osm>"""
    path = tmp_path / "plus.osm"
    path.write_text(xml)
    g = build_graph(path)
    turns = sorted((round(float(g.edge_h1[a])), round(float(g.edge_h0[b])))
                   for a, b in zip(g.ban_from, g.ban_to, strict=True))
    assert turns == [(0, 90), (180, 270)]  # northbound -> east, southbound -> west


def test_pack_round_trip(grid, tmp_path):
    path = tmp_path / "grid.fwr"
    sections = pack_sections(grid)
    size = write_pack(path, pack_meta(grid, "grid.osm", "test"), sections)
    assert path.stat().st_size == size
    meta, arrays = read_pack(path)
    assert meta["counts"]["edges"] == 78
    for name, arr in sections.items():
        np.testing.assert_array_equal(arrays[name], arr)
    np.testing.assert_array_equal(decode_vertices(arrays), grid.geom_q)


def test_road_label():
    assert road_label({"highway": "residential"}) == ""
    assert road_label({"name": "Oak Avenue"}) == LABEL_SEP.join(["Oak Avenue", "", ""])
    assert road_label({"name": "Central Expressway", "ref": "US 75; TX 289"}) == LABEL_SEP.join(
        ["Central Expressway", "US 75; TX 289", ""])
    assert road_label({"highway": "motorway_link", "destination": "Downtown;Plano"}) == LABEL_SEP.join(
        ["", "", "Downtown; Plano"])
    assert road_label({"highway": "motorway_link", "destination:ref": "I 30"}).endswith("I 30")
    assert "\0" not in road_label({"name": "Bad\0Name\x1f"})


def test_labels_ride_in_the_pack_without_changing_the_routing(tmp_path):
    xml, _ = guide_osm()
    (tmp_path / "guide.osm").write_text(xml)
    g = build_graph(tmp_path / "guide.osm")
    sections = pack_sections(g)
    write_pack(tmp_path / "guide.fwr", pack_meta(g, "guide.osm", "test"), sections)
    meta, arrays = read_pack(tmp_path / "guide.fwr")
    labels = decode_labels(arrays)
    assert labels == g.labels and labels[0] == ""
    named = {labels[i].split(LABEL_SEP)[0] for i in arrays["geom_label"]}
    assert {"Main Street", "Commerce Street", "Stemmons Freeway", "Back Road", ""} <= named
    assert [labels[i] for i in arrays["geom_label"]].count(LABEL_SEP.join(["", "", "Downtown"])) == 1
    ring = arrays["geom_flags"] & FLAG_ROUNDABOUT
    assert ring.sum() == 4  # the roundabout's four quarters
    assert {labels[i] for i in arrays["geom_label"][ring > 0]} == {""}
    # The routing sections are what they always were; renaming a road changes the fingerprint.
    renamed = {**sections, "labels": np.frombuffer(bytes(sections["labels"]).replace(b"Oak", b"Elm"), np.uint8)}
    assert fingerprint(meta, renamed) != fingerprint(meta, sections)


def test_a_pack_without_labels_reads_as_unnamed():
    assert decode_labels({}) == [""]
