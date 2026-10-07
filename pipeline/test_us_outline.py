import json

from shapely.geometry import box, shape

from pipeline import us_outline
from pipeline.regions import US

TEXAS = box(-106.6, 25.8, -93.5, 36.5)


def test_lower48_leaves_out_alaska_and_hawaii():
    polys = {f"{US}texas": TEXAS, f"{US}alaska": box(-170, 51, -130, 71.5), f"{US}hawaii": box(-160.3, 18.9, -154.8, 22.3)}
    w, s, e, n = us_outline.lower48(polys).bounds
    assert -106.7 < w and e < -93.4 and 25.7 < s and n < 36.6  # Texas, padded by 0.02 degrees


def test_main_writes_a_geojson_feature(tmp_path, monkeypatch):
    monkeypatch.setattr(us_outline, "load_polys", lambda cache: {f"{US}texas": TEXAS})
    out = tmp_path / "lower48.geojson"
    assert us_outline.main(["--out", str(out), "--cache", str(tmp_path)]) == 0
    feature = json.loads(out.read_text())
    assert feature["type"] == "Feature" and shape(feature["geometry"]).contains(box(-100, 30, -99, 31))
