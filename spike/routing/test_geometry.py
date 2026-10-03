import math

import numpy as np
import pytest
from shapely.geometry import Point, Polygon

from geometry import (
    PROFILES,
    Camera,
    LocalProjection,
    camera_from_tags,
    captures,
    heading_matches,
    parse_direction,
    sector_distance,
)

P = PROFILES["default"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("45", [(45.0, 0.0)]),
        ("-30", [(330.0, 0.0)]),
        ("360", [(0.0, 0.0)]),
        ("90;270", [(90.0, 0.0), (270.0, 0.0)]),
        ("10-30", [(20.0, 10.0)]),
        ("350-10", [(0.0, 10.0)]),  # wraps through north
        ("NE", [(45.0, 0.0)]),
        ("ssw", [(202.5, 0.0)]),
        ("forward", None),
        ("fixed", None),
        ("150000099", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_direction(raw, expected):
    assert parse_direction(raw) == expected


def test_sector_distance_hand_cases():
    # North-facing 30-degree half-angle sector, R = 50.
    def dist(x, y):
        return float(sector_distance(x, y, 0.0, 30.0, 50.0))

    assert dist(0, 0) == 0  # apex
    assert dist(0, 40) == 0  # on axis, inside
    assert dist(0, 70) == pytest.approx(20)  # on axis, past the arc
    assert dist(0, -25) == pytest.approx(25)  # directly behind -> apex is nearest
    # Due east at d = 40: 90 deg off axis, 60 deg past the edge ray; projection 20 < R.
    assert dist(40, 0) == pytest.approx(40 * math.sin(math.radians(60)))
    # Far out beside the ray, projection past R -> nearest point is the ray's end.
    end = np.array([50 * math.sin(math.radians(30)), 50 * math.cos(math.radians(30))])
    p = np.array([200.0, 120.0])
    assert dist(*p) == pytest.approx(np.linalg.norm(p - end))


def _sector_polygon(bearing, half_angle, r, n=4000):
    angles = np.radians(np.linspace(bearing - half_angle, bearing + half_angle, n))
    arc = np.column_stack([r * np.sin(angles), r * np.cos(angles)])
    return Polygon(arc if half_angle >= 180 else np.vstack([[0.0, 0.0], arc]))


@pytest.mark.parametrize("half_angle", [5, 15, 30, 45, 89, 90, 120, 179.5, 180])
def test_sector_distance_matches_shapely(half_angle):
    rng = np.random.default_rng(int(half_angle * 10))
    r = 50.0
    bearing = float(rng.uniform(0, 360))
    poly = _sector_polygon(bearing, half_angle, r)
    pts = rng.uniform(-3 * r, 3 * r, size=(2000, 2))
    ours = sector_distance(pts[:, 0], pts[:, 1], bearing, half_angle, r)
    ref = np.array([poly.distance(Point(x, y)) for x, y in pts])
    # The polygon's arc is a 4000-gon; its inscribed error is ~1e-5 m at R = 50.
    np.testing.assert_allclose(ours, ref, atol=1e-3)


def test_heading_modes():
    assert heading_matches(10.0, 0.0, "rear", 45)
    assert not heading_matches(180.0, 0.0, "rear", 45)
    assert heading_matches(190.0, 0.0, "axis", 45)  # opposite direction on the axis
    assert not heading_matches(90.0, 0.0, "axis", 45)  # crossing traffic
    assert heading_matches(90.0, 0.0, "any", 45)
    assert heading_matches(355.0, 10.0, "rear", 30)  # wraps through north


def test_captures_flock_is_one_directional():
    flock = Camera(1, 0.0, 0.0, "rear", ((0.0, P.half_angle),), "Flock Safety")
    assert captures(flock, 0, 30, 0.0, P)  # ahead of the camera, driving away: rear plate
    assert not captures(flock, 0, 30, 180.0, P)  # same spot, oncoming
    assert not captures(flock, 0, -30, 0.0, P)  # behind the pole, outside eps
    assert captures(flock, 0, -5, 0.0, P)  # within eps of the pole
    axis = Camera(2, 0.0, 0.0, "axis", ((0.0, P.half_angle),), "Motorola Solutions")
    assert captures(axis, 0, 30, 180.0, P)


def test_captures_multi_sector_and_vectorised():
    cam = Camera(3, 0.0, 0.0, "axis", ((90.0, 30.0), (270.0, 30.0)), "Genetec")
    xs = np.array([30.0, -30.0, 0.0])
    ys = np.array([0.0, 0.0, 30.0])
    np.testing.assert_array_equal(captures(cam, xs, ys, np.array([90.0, 270.0, 0.0]), P),
                                  [True, True, False])


def test_camera_from_tags():
    flock = camera_from_tags(1, 0, 0, {"manufacturer": "Flock Safety", "direction": "90"}, P)
    assert flock.mode == "rear" and flock.sectors == ((90.0, P.half_angle),)
    moto = camera_from_tags(2, 0, 0, {"brand": "Motorola Solutions", "direction": "0-60"}, P)
    assert moto.mode == "axis" and moto.sectors == ((30.0, P.half_angle + 30),)
    unknown = camera_from_tags(3, 0, 0, {"manufacturer": "Flock Safety", "direction": "fixed"}, P)
    assert unknown.mode == "any" and unknown.sectors == ((0.0, 180.0),)
    assert camera_from_tags(4, 0, 0, {"manufacturer": "Flock Safety", "direction": "0"}, P,
                            omni=True).mode == "any"


def test_local_projection_distance_vs_haversine():
    proj = LocalProjection(32.78, -96.80)
    lon = np.array([-96.80, -96.7990])
    lat = np.array([32.78, 32.7808])
    x, y = proj.to_xy(lon, lat)
    ours = math.hypot(x[1] - x[0], y[1] - y[0])
    p1, p2 = np.radians(lat)
    dl = math.radians(lon[1] - lon[0])
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    hav = 2 * 6_371_008.8 * math.asin(math.sqrt(a))
    assert ours == pytest.approx(hav, rel=1e-4)
    lon_back, lat_back = proj.to_lonlat(x, y)
    np.testing.assert_allclose(lon_back, lon)
    np.testing.assert_allclose(lat_back, lat)
