"""Why do some mapped cameras capture no drivable road? Classify them under the default profile.

  off-network   - no routable road sample within R + eps (parking lots, private drives, or
                  mispositioned nodes); invisible to routing however it's modelled
  bearing       - roads are in reach, but none in a captured heading: either the mapped
                  bearing is off, or the camera watches something we excluded (a lot entrance)
"""

from __future__ import annotations

from collections import Counter

import numpy as np
from scipy.spatial import cKDTree

from exposure import edge_exposure, sample_geometries
from experiment import EXTRACT_BBOX, HERE, STEP_M, Network, load_cameras
from geometry import PROFILES, camera_from_tags

params = PROFILES["default"]
net = Network(HERE / "data" / "Dallas.graph.npz")
# Outside the extract rectangle the graph only has the stubs of boundary-crossing ways, so
# cameras there look "off-network" for want of data.
w, s, e, n = EXTRACT_BBOX
records = [r for r in load_cameras(net) if w <= r["lon"] <= e and s <= r["lat"] <= n]
samples = sample_geometries(net.offsets, net.geom_xy, STEP_M)
tree = cKDTree(samples.xy)


def touched(omni: bool) -> np.ndarray:
    cams = [camera_from_tags(r["id"], r["x"], r["y"], r.get("tags", {}), params, omni) for r in records]
    # No site_of: every camera is its own site, so site_idx indexes cameras.
    ex = edge_exposure(samples, cams, params, net.edge_geom, net.edge_rev, net.geom_len, tree)
    hit = np.zeros(len(cams), bool)
    hit[ex.site_idx] = True
    return hit


directional, omni = touched(False), touched(True)
nearest, _ = tree.query(np.array([[r["x"], r["y"]] for r in records]))
off_network = nearest > params.range_m + params.eps_m
bearing = ~directional & ~off_network
print(f"cameras: {len(records)}; capture a road: {directional.sum()} ({100 * directional.mean():.1f}%)")
print(f"  off-network (nearest routable road > {params.range_m + params.eps_m:.0f} m): {off_network.sum()}")
print(f"  bearing mismatch (road in reach, none in a captured heading): {bearing.sum()}"
      f"  - of which captured if heading is ignored: {(bearing & omni).sum()}")
print(f"  median distance to nearest routable road: all {np.median(nearest):.1f} m, "
      f"off-network {np.median(nearest[off_network]):.0f} m")
for label, mask in (("off-network", off_network), ("bearing", bearing)):
    ops = Counter(records[i].get("tags", {}).get("operator", "(none)") for i in np.flatnonzero(mask))
    print(f"  top operators, {label}: {ops.most_common(5)}")
