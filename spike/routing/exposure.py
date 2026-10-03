"""Camera exposure per directed graph edge, via the shared capture predicate.

Each road polyline is sampled every `step` metres. A sample carries a position, the
heading of its polyline segment, and the length of road it stands for. For every camera,
the samples within R + eps are tested with `geometry.captures` twice: once heading
forward along the polyline, once reversed. Per directed edge this yields:

  exposure x_e = sum over sites s of min(1, captured_length(e, s) / L_ref(s))
  sites(e)     = capture sites that log the edge at all, with where the capture starts

A *site* is a cluster of co-located cameras (a pole, a per-lane gantry): passing it records
you once, however many lenses it has, so the site is the privacy unit. A site's zone is the
union of its cameras' zones.

x_e is the routing cost term. It is additive along a path and counts one full pass through
a zone as one, however many graph edges the pass spans. sites(e) gives the exact
distinct-site count used to *evaluate* routes, and the alert list.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import cKDTree

from geometry import Camera, ZoneParams, captures, compass_bearing, zone_reference_length


@dataclass
class Samples:
    xy: np.ndarray  # (n, 2) metres
    heading: np.ndarray  # forward-direction compass bearing of the host segment
    weight: np.ndarray  # metres of road this sample stands for
    s: np.ndarray  # distance from the start of its geometry
    geom: np.ndarray  # geometry index


def sample_geometries(offsets: np.ndarray, xy: np.ndarray, step: float) -> Samples:
    n_geoms = len(offsets) - 1
    seg = np.arange(len(xy) - 1)
    seg = seg[~np.isin(seg, offsets[1:-1] - 1)]  # drop joins between consecutive geometries
    a, vec = xy[seg], xy[seg + 1] - xy[seg]
    seg_len = np.hypot(vec[:, 0], vec[:, 1])
    seg_geom = np.searchsorted(offsets, seg, side="right") - 1
    before = np.cumsum(seg_len) - seg_len
    s0 = before - before[offsets[:-1] - np.arange(n_geoms)][seg_geom]

    keep = seg_len > 0.01  # duplicate-coordinate segments have no heading
    a, vec, seg_len, seg_geom, s0 = a[keep], vec[keep], seg_len[keep], seg_geom[keep], s0[keep]
    heading = compass_bearing(vec[:, 0], vec[:, 1])

    n = np.maximum(1, np.ceil(seg_len / step)).astype(np.int64)
    rep = np.repeat(np.arange(len(n)), n)
    t = (np.arange(rep.size) - np.repeat(np.cumsum(n) - n, n)) / n[rep]
    # One extra zero-weight sample at each geometry's far end, so reverse travel has a
    # first sample in travel order.
    last = np.flatnonzero(np.r_[seg_geom[1:] != seg_geom[:-1], True])
    return Samples(
        xy=np.vstack([a[rep] + t[:, None] * vec[rep], a[last] + vec[last]]),
        heading=np.concatenate([heading[rep], heading[last]]),
        weight=np.concatenate([seg_len[rep] / n[rep], np.zeros(len(last))]),
        s=np.concatenate([s0[rep] + t * seg_len[rep], s0[last] + seg_len[last]]),
        geom=np.concatenate([seg_geom[rep], seg_geom[last]]),
    )


def cluster_sites(cams: list[Camera], radius_m: float = 25.0) -> np.ndarray:
    """Site index per camera: cameras within `radius_m` of each other (transitively) share
    a site. Lanes are ~3.7 m apart and multi-camera poles are mapped as separate nodes a few
    metres apart, so 25 m merges installations without merging neighbouring intersections."""
    parent = np.arange(len(cams))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in cKDTree(np.array([[c.x, c.y] for c in cams])).query_pairs(radius_m):
        ri, rj = root(i), root(j)
        parent[max(ri, rj)] = min(ri, rj)
    return np.unique([root(i) for i in range(len(cams))], return_inverse=True)[1]


@dataclass
class EdgeExposure:
    x: np.ndarray  # (n_edges,) exposure units
    site_ptr: np.ndarray  # CSR over edges -> sites
    site_idx: np.ndarray  # site index (see cluster_sites)
    site_entry: np.ndarray  # metres from the edge's start (travel order) to first capture
    site_units: np.ndarray  # that site's contribution to x


def edge_exposure(samples: Samples, cams: list[Camera], params: ZoneParams,
                  edge_geom: np.ndarray, edge_rev: np.ndarray, geom_len: np.ndarray,
                  tree: cKDTree | None = None, site_of: np.ndarray | None = None) -> EdgeExposure:
    tree = tree or cKDTree(samples.xy)
    site_of = np.arange(len(cams)) if site_of is None else np.asarray(site_of)
    n_sites = int(site_of.max()) + 1
    cam_xy = np.array([[c.x, c.y] for c in cams])
    neighbours = tree.query_ball_point(cam_xy, r=params.range_m + params.eps_m)

    # rows: (camera, sample, travel direction) for every capturing sample
    rc, rs, rd = [np.empty(0, int)], [np.empty(0, int)], [np.empty(0, int)]
    for ci, (cam, idx) in enumerate(zip(cams, neighbours, strict=True)):
        if not idx:
            continue
        idx = np.asarray(idx)
        px, py, h = samples.xy[idx, 0], samples.xy[idx, 1], samples.heading[idx]
        for d, heading in ((0, h), (1, h + 180.0)):
            hit = idx[captures(cam, px, py, heading, params)]
            rc.append(np.full(hit.size, ci))
            rs.append(hit)
            rd.append(np.full(hit.size, d))
    cam_i, smp, rev = (np.concatenate(v).astype(np.int64) for v in (rc, rs, rd))

    # A sample logged by several cameras of one site counts once (union of their zones).
    site = site_of[cam_i]
    _, first = np.unique((site * len(samples.xy) + smp) * 2 + rev, return_index=True)
    site, smp, rev = site[first], smp[first], rev[first]

    # Map each capturing sample to its directed edge; skip directions the road doesn't allow.
    n_geoms = len(geom_len)
    edge_of = np.full((n_geoms, 2), -1)
    edge_of[edge_geom, edge_rev.astype(int)] = np.arange(len(edge_geom))
    g = samples.geom[smp]
    edge = edge_of[g, rev]
    ok = edge >= 0
    site, smp, rev, g, edge = site[ok], smp[ok], rev[ok], g[ok], edge[ok]
    along = np.where(rev == 1, geom_len[g] - samples.s[smp], samples.s[smp])

    uniq, inv = np.unique(edge * n_sites + site, return_inverse=True)
    captured_len = np.bincount(inv, weights=samples.weight[smp], minlength=len(uniq))
    entry = np.full(len(uniq), np.inf)
    np.minimum.at(entry, inv, along)
    u_edge, u_site = uniq // n_sites, uniq % n_sites
    l_ref = np.zeros(n_sites)
    np.maximum.at(l_ref, site_of, [zone_reference_length(c, params) for c in cams])
    units = np.minimum(1.0, captured_len / l_ref[u_site])

    x = np.bincount(u_edge, weights=units, minlength=len(edge_geom))
    ptr = np.concatenate([[0], np.cumsum(np.bincount(u_edge, minlength=len(edge_geom)))])
    return EdgeExposure(x=x, site_ptr=ptr, site_idx=u_site, site_entry=entry, site_units=units)
