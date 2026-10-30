import osmium

from pipeline.merge import merge_newest


def _osm(path, nodes, ways):
    out = ['<?xml version="1.0" encoding="UTF-8"?><osm version="0.6">']
    for nid, version in nodes:
        out.append(f'<node id="{nid}" version="{version}" timestamp="2026-10-{10 + version:02d}T00:00:00Z" '
                   f'lat="32.{nid}" lon="-96.{nid}"/>')
    for wid, version, refs in ways:
        nds = "".join(f'<nd ref="{r}"/>' for r in refs)
        out.append(f'<way id="{wid}" version="{version}" timestamp="2026-10-{10 + version:02d}T00:00:00Z">{nds}'
                   '<tag k="highway" v="primary"/></way>')
    path.write_text("".join(out) + "</osm>")
    return path


class _Objects(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.seen = []

    def node(self, n):
        self.seen.append(("n", n.id, n.version))

    def way(self, w):
        self.seen.append(("w", w.id, w.version, [r.ref for r in w.nodes]))


def test_a_road_across_a_state_line_comes_out_once_in_its_newest_version(tmp_path):
    # Two states rolled forward to different days: the road on their line is version 1 in one
    # state's file and version 2 (one node longer) in the other's. `osmium merge` kept both.
    older = _osm(tmp_path / "a.osm", [(1, 1), (2, 1), (3, 1)], [(10, 1, [1, 2])])
    newer = _osm(tmp_path / "b.osm", [(1, 1), (2, 2), (3, 1), (4, 1)], [(10, 2, [1, 2, 3]), (11, 1, [3, 4])])
    out = tmp_path / "merged.osm.pbf"
    out.write_bytes(b"stale")  # an earlier run's file is replaced
    for order in ([older, newer], [newer, older]):
        merge_newest(order, out)
        objects = _Objects()
        objects.apply_file(str(out))
        assert objects.seen == [("n", 1, 1), ("n", 2, 2), ("n", 3, 1), ("n", 4, 1),
                                ("w", 10, 2, [1, 2, 3]), ("w", 11, 1, [3, 4])]
