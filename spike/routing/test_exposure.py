import numpy as np
import pytest

from exposure import cluster_sites, edge_exposure, sample_geometries
from geometry import PROFILES, Camera

P = PROFILES["default"]  # R = 50, alpha = 30, eps = 12, beta = 45


def _road():
    """A north-south road on x = 0, split into two edges at y = 0 (next to the pole).
    Both geometries are two-way: edges 0, 1 run north; edges 2, 3 run south."""
    xy = np.array([[0.0, -200.0], [0.0, 0.0], [0.0, 0.0], [0.0, 200.0]])
    offsets = np.array([0, 2, 4])
    geom_len = np.array([200.0, 200.0])
    edge_geom = np.array([0, 1, 0, 1])
    edge_rev = np.array([False, False, True, True])
    return xy, offsets, geom_len, edge_geom, edge_rev


def _exposure(*cams, site_of=None):
    xy, offsets, geom_len, edge_geom, edge_rev = _road()
    samples = sample_geometries(offsets, xy, step=1.0)
    return edge_exposure(samples, list(cams), P, edge_geom, edge_rev, geom_len, site_of=site_of)


def test_flock_pass_split_across_edges_counts_once_and_one_way():
    # Pole 5 m east of the centreline, facing north. Along x = 0 the buffered zone runs
    # from y = -sqrt(12^2 - 5^2) = -10.9 (eps disc round the pole) to y = sqrt(62^2 - 5^2)
    # = 61.8 (R + eps), i.e. 72.7 m of a 74 m reference pass.
    ex = _exposure(Camera(1, 5.0, 0.0, "rear", ((0.0, P.half_angle),), "Flock Safety"))
    assert ex.x[0] == pytest.approx(10.9 / 74, abs=0.02)
    assert ex.x[1] == pytest.approx(61.8 / 74, abs=0.02)
    assert ex.x[0] + ex.x[1] == pytest.approx(72.7 / 74, abs=0.03)
    assert ex.x[2] == 0 and ex.x[3] == 0  # southbound sees no rear plate
    # Capture starts 189 m into the first northbound edge, and right at the start of the second.
    entries = dict(zip(np.repeat(np.arange(4), np.diff(ex.site_ptr)), ex.site_entry, strict=True))
    assert entries[0] == pytest.approx(200 - 10.9, abs=1.0)
    assert entries[1] == pytest.approx(0.0, abs=1.0)


def test_axis_camera_exposes_both_directions():
    ex = _exposure(Camera(2, 5.0, 0.0, "axis", ((0.0, P.half_angle),), "Motorola Solutions"))
    assert ex.x[0] + ex.x[1] == pytest.approx(ex.x[2] + ex.x[3], abs=0.03)
    assert ex.x[2] + ex.x[3] > 0.9


def test_camera_facing_away_from_road_touches_nothing():
    # 30 m east of the road, looking further east: the zone never comes within eps of x = 0.
    ex = _exposure(Camera(3, 30.0, 0.0, "rear", ((90.0, P.half_angle),), "Flock Safety"))
    assert ex.x.sum() == 0 and len(ex.site_idx) == 0


def test_gantry_lanes_merge_into_one_site():
    # Two lane cameras 3.7 m apart, both watching northbound: one capture, not two.
    lanes = [Camera(10, 5.0, 0.0, "rear", ((0.0, P.half_angle),), "Motorola Solutions"),
             Camera(11, 8.7, 0.0, "rear", ((0.0, P.half_angle),), "Motorola Solutions")]
    far = Camera(12, 5.0, 150.0, "rear", ((0.0, P.half_angle),), "Flock Safety")
    sites = cluster_sites([*lanes, far])
    assert sites[0] == sites[1] != sites[2]
    ex = _exposure(*lanes, site_of=sites[:2])
    assert ex.x[0] + ex.x[1] == pytest.approx(72.7 / 74, abs=0.03)  # not doubled
    assert set(ex.site_idx.tolist()) == {0}
