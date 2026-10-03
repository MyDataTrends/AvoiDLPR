"""Routing spike: what does avoiding ALPR capture zones cost on a real road network?

Route cost is a weighted sum of travel time and camera exposure:

    W(P) = T(P) + lambda * X(P)

lambda is in seconds per capture-site pass, i.e. how much extra driving one avoided
capture is worth. Sweeping lambda traces the supported points of each trip's
time-vs-captures Pareto frontier. Routes are then *evaluated* by D(P), the exact number
of distinct capture sites that log the route.

Usage: python experiment.py   (needs data/Dallas.graph.npz from build_graph.py)
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components, dijkstra
from scipy.spatial import cKDTree

from exposure import EdgeExposure, cluster_sites, edge_exposure, sample_geometries
from geometry import PROFILES, LocalProjection, camera_from_tags, compass_bearing, wrap180

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402

HERE = Path(__file__).parent
REGIONS = HERE.parent / "regions"
FIGURES = HERE / "figures"
LAMBDAS = [0, 10, 30, 60, 120, 300, 600, 1800]
BUDGETS = [0.0, 0.05, 0.10, 0.20, 0.50]
N_SOURCES, TARGETS_PER_SOURCE, TRIP_KM = 60, 5, (3.0, 25.0)
STEP_M, SEED = 5.0, 7
# BBBike's Dallas extract rectangle (Dallas.poly). Ways crossing it are kept whole, so the
# graph's bbox is a little larger; coverage stats only count sites inside the rectangle.
EXTRACT_BBOX = (-97.05, 32.63, -96.53, 32.94)
# Free-flow times ignore junction delay. Routes are re-scored with a flat cost per turn
# (heading change > TURN_DEG at a junction) to check avoidance isn't buying its savings
# with turns the time model doesn't charge for.
TURN_DEG, TURN_S = 45.0, 10.0
RUNS = [  # (name, params, omni)
    ("default", PROFILES["default"], False),
    ("strict", PROFILES["strict"], False),
    ("loose", PROFILES["loose"], False),
    ("default-omni", PROFILES["default"], True),
]


class Network:
    def __init__(self, path: Path):
        g = np.load(path)
        self.proj = LocalProjection(float(g["lat0"]), float(g["lon0"]))
        self.node_xy, self.node_lonlat = g["node_xy"], g["node_lonlat"]
        self.offsets, self.geom_xy, self.geom_len = g["geom_offsets"], g["geom_xy"], g["geom_len"]
        self.geom_hw = g["geom_hw"]
        fwd, rev = np.flatnonzero(g["geom_fwd"]), np.flatnonzero(g["geom_rev"])
        self.edge_geom = np.concatenate([fwd, rev])
        self.edge_rev = np.r_[np.zeros(len(fwd), bool), np.ones(len(rev), bool)]
        u, v = g["geom_u"][self.edge_geom], g["geom_v"][self.edge_geom]
        self.src = np.where(self.edge_rev, v, u)
        self.dst = np.where(self.edge_rev, u, v)
        self.length = self.geom_len[self.edge_geom]
        self.time = np.maximum(self.length / (g["geom_kmh"][self.edge_geom] / 3.6), 1e-3)
        self.n = len(self.node_xy)
        # Heading leaving the start node and arriving at the end node, per directed edge.
        o = self.offsets
        first = compass_bearing(*(self.geom_xy[o[:-1] + 1] - self.geom_xy[o[:-1]]).T)
        last = compass_bearing(*(self.geom_xy[o[1:] - 1] - self.geom_xy[o[1:] - 2]).T)
        fh, lh = first[self.edge_geom], last[self.edge_geom]
        self.start_h = np.where(self.edge_rev, lh + 180.0, fh) % 360
        self.end_h = np.where(self.edge_rev, fh + 180.0, lh) % 360

    def csr(self, weight: np.ndarray):
        """Graph for one weighting. Parallel edges keep the cheapest; returns the matrix plus
        a (u*n + v) -> edge id lookup for path reconstruction."""
        m = self.src != self.dst
        u, v, w, eid = self.src[m], self.dst[m], weight[m], np.flatnonzero(m)
        o = np.lexsort((w, v, u))
        u, v, w, eid = u[o], v[o], w[o], eid[o]
        first = np.r_[True, (u[1:] != u[:-1]) | (v[1:] != v[:-1])]
        u, v, w, eid = u[first], v[first], w[first], eid[first]
        return csr_matrix((w, (u, v)), shape=(self.n, self.n)), u * self.n + v, eid

    def turns(self, edges: np.ndarray) -> int:
        return int(np.sum(np.abs(wrap180(self.start_h[edges[1:]] - self.end_h[edges[:-1]])) > TURN_DEG))

    def geometry(self, edges: np.ndarray) -> np.ndarray:
        parts = []
        for e in edges:
            g = self.edge_geom[e]
            pts = self.geom_xy[self.offsets[g]:self.offsets[g + 1]]
            parts.append(pts[::-1] if self.edge_rev[e] else pts)
        return np.vstack(parts)


def load_cameras(net: Network) -> list[dict]:
    raw: dict[int, dict] = {}
    for f in REGIONS.glob("*.json"):
        for rec in json.loads(f.read_text()):
            raw[rec["id"]] = rec
    (w, s), (e, n) = net.node_lonlat.min(axis=0), net.node_lonlat.max(axis=0)
    out = [r for r in raw.values() if w <= r["lon"] <= e and s <= r["lat"] <= n]
    x, y = net.proj.to_xy([r["lon"] for r in out], [r["lat"] for r in out])
    for r, xi, yi in zip(out, x, y, strict=True):
        r["x"], r["y"] = float(xi), float(yi)
    return out


def trace(pred: np.ndarray, s: int, t: int) -> np.ndarray | None:
    seq = [t]
    while seq[-1] != s:
        p = pred[seq[-1]]
        if p < 0:
            return None
        seq.append(int(p))
    return np.array(seq[::-1])


def distinct_sites(edges: np.ndarray, ex: EdgeExposure) -> np.ndarray:
    lo, hi = ex.site_ptr[edges], ex.site_ptr[edges + 1]
    hits = [ex.site_idx[a:b] for a, b in zip(lo, hi, strict=True) if b > a]
    return np.unique(np.concatenate(hits)) if hits else np.array([], int)


def alerts(edges: np.ndarray, net: Network, ex: EdgeExposure) -> list[tuple[float, int]]:
    """(metres along route at which capture starts, site), first capture per site."""
    start = np.concatenate([[0.0], np.cumsum(net.length[edges])[:-1]])
    first: dict[int, float] = {}
    for e, s0 in zip(edges, start, strict=True):
        for k in range(ex.site_ptr[e], ex.site_ptr[e + 1]):
            first.setdefault(int(ex.site_idx[k]), s0 + ex.site_entry[k])
    return sorted((d, s) for s, d in first.items())


def main() -> None:
    t_start = time.perf_counter()
    net = Network(HERE / "data" / "Dallas.graph.npz")
    records = load_cameras(net)
    positions = [camera_from_tags(r["id"], r["x"], r["y"], r.get("tags", {}), PROFILES["default"])
                 for r in records]
    site_of = cluster_sites(positions)
    n_sites = int(site_of.max()) + 1
    w, s, e, n = EXTRACT_BBOX
    inside = np.array([w <= r["lon"] <= e and s <= r["lat"] <= n for r in records])
    site_inside = np.zeros(n_sites, bool)
    site_inside[site_of[inside]] = True
    print(f"graph: {net.n:,} nodes, {len(net.src):,} directed edges")
    print(f"cameras: {len(records):,} ({inside.sum():,} inside the extract rectangle) "
          f"-> {n_sites:,} capture sites ({site_inside.sum():,} inside)")

    samples = sample_geometries(net.offsets, net.geom_xy, STEP_M)
    tree = cKDTree(samples.xy)
    print(f"road samples: {len(samples.xy):,} at {STEP_M:.0f} m  [{time.perf_counter() - t_start:.1f}s]")

    any_csr, _, _ = net.csr(net.time)
    _, labels = connected_components(any_csr, directed=True, connection="strong")
    big = np.flatnonzero(labels == np.bincount(labels).argmax())
    rng = np.random.default_rng(SEED)
    pairs = []
    for src in rng.choice(big, N_SOURCES, replace=False):
        d = np.hypot(*(net.node_xy[big] - net.node_xy[src]).T) / 1000
        cand = big[(d >= TRIP_KM[0]) & (d <= TRIP_KM[1])]
        pairs += [(int(src), int(t)) for t in rng.choice(cand, TARGETS_PER_SOURCE, replace=False)]
    print(f"largest SCC: {len(big):,} nodes; trips: {len(pairs)}")

    rows, kept_routes, exposures, cams_by_run, dijkstra_s = [], {}, {}, {}, []
    for name, params, omni in RUNS:
        cams = [camera_from_tags(r["id"], r["x"], r["y"], r.get("tags", {}), params, omni)
                for r in records]
        ex = edge_exposure(samples, cams, params, net.edge_geom, net.edge_rev, net.geom_len,
                           tree, site_of)
        exposures[name], cams_by_run[name] = ex, cams
        logged = np.zeros(n_sites, bool)
        logged[ex.site_idx] = True
        print(f"\n[{name}] R={params.range_m} alpha={params.half_angle} eps={params.eps_m} "
              f"beta={params.heading_tol} omni={omni}")
        print(f"  sites (inside extract) that log a drivable edge: {(logged & site_inside).sum():,}/"
              f"{site_inside.sum():,} ({100 * logged[site_inside].mean():.1f}%);  "
              f"directed-edge km with exposure: {net.length[ex.x > 0].sum() / 1000:,.0f}")

        for lam in LAMBDAS:
            csr, keys, eid = net.csr(net.time + lam * ex.x)
            for src in sorted({p[0] for p in pairs}):
                t0 = time.perf_counter()
                _, pred = dijkstra(csr, directed=True, indices=src, return_predecessors=True)
                dijkstra_s.append(time.perf_counter() - t0)
                for pi, (ps, pt) in enumerate(pairs):
                    if ps != src:
                        continue
                    nodes = trace(pred, src, pt)
                    edges = eid[np.searchsorted(keys, nodes[:-1] * net.n + nodes[1:])]
                    rows.append(dict(run=name, lam=lam, pair=pi, T=net.time[edges].sum(),
                                     L=net.length[edges].sum(), X=ex.x[edges].sum(),
                                     D=len(distinct_sites(edges, ex)), turns=net.turns(edges)))
                    if name == "default":
                        kept_routes[(lam, pi)] = edges
        print(f"  routed {len(LAMBDAS)} lambdas  [{time.perf_counter() - t_start:.1f}s]")

    df = pd.DataFrame(rows)
    df["Tadj"] = df["T"] + TURN_S * df["turns"]
    base = df[df.lam == 0].set_index(["run", "pair"])
    idx = pd.MultiIndex.from_frame(df[["run", "pair"]])
    for col in ("T", "D", "Tadj", "turns"):
        df[f"{col}0"] = base[col].reindex(idx).to_numpy()
    df["overhead"] = df["T"] / df["T0"] - 1
    df["overhead_adj"] = df["Tadj"] / df["Tadj0"] - 1
    FIGURES.mkdir(exist_ok=True)
    df.to_csv(HERE / "data" / "results.csv", index=False)

    print(f"\nDijkstra per query: median {1000 * np.median(dijkstra_s):.0f} ms "
          f"(scipy, {net.n:,} nodes)")
    report(df, net, records, site_of, cams_by_run["default"], exposures["default"], kept_routes, pairs)
    print(f"\ndone in {time.perf_counter() - t_start:.0f}s")


def report(df, net, records, site_of, cams, ex, kept_routes, pairs) -> None:
    pd.set_option("display.width", 170)
    fast = df[df.lam == 0]
    print("\n== Fastest routes (lambda = 0) ==")
    t = fast.groupby("run").agg(trips=("pair", "size"), km=("L", lambda s: s.mean() / 1000),
                                minutes=("T", lambda s: s.mean() / 60), sites_mean=("D", "mean"),
                                sites_median=("D", "median"),
                                capture_free=("D", lambda s: (s == 0).mean()))
    t["sites_per_10km"] = fast.groupby("run").apply(lambda g: 10_000 * g.D.sum() / g.L.sum(),
                                                    include_groups=False)
    print(t.round(2).to_string())

    print("\n== Sweep: mean over trips ==")
    sweep = df.groupby(["run", "lam"]).agg(
        overhead=("overhead", "mean"), overhead_p90=("overhead", lambda s: s.quantile(0.9)),
        overhead_turnadj=("overhead_adj", "mean"), extra_turns=("turns", "mean"),
        sites=("D", "mean"), exposure=("X", "mean"), capture_free=("D", lambda s: (s == 0).mean()))
    sweep["extra_turns"] -= df.groupby(["run", "lam"]).turns0.mean()
    print(sweep.round(3).to_string())

    budget_rows = []
    for (run, pair), g in df.groupby(["run", "pair"]):
        for b in BUDGETS:
            budget_rows.append(dict(run=run, pair=pair, budget=b, D0=g.D0.iloc[0],
                                    D=g[g.overhead <= b + 1e-9].D.min(),
                                    D_adj=g[g.overhead_adj <= b + 1e-9].D.min()))
    bud = pd.DataFrame(budget_rows)
    btab = bud.groupby(["run", "budget"]).agg(
        sites=("D", "mean"), capture_free=("D", lambda s: (s == 0).mean()),
        sites_turnadj=("D_adj", "mean"), capture_free_turnadj=("D_adj", lambda s: (s == 0).mean()))
    d0 = bud.groupby(["run", "budget"]).D0.mean()
    btab.insert(2, "cut", 1 - btab.sites / d0)
    btab["cut_turnadj"] = 1 - btab.sites_turnadj / d0
    print("\n== Fewest capture sites within a time budget (over the lambda sweep) ==")
    print(btab.round(3).to_string())

    plot_tradeoff(df, bud)
    plot_example(df, net, records, site_of, cams, ex, kept_routes, pairs)


COLORS = {"default": "#2a6fdb", "strict": "#1b9e77", "loose": "#d95f02", "default-omni": "#7a7a7a"}


def plot_tradeoff(df: pd.DataFrame, bud: pd.DataFrame) -> None:
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 4.8))
    for run, g in df.groupby("run"):
        s = g.groupby("lam").agg(o=("overhead", "mean"), d=("D", "mean")).reset_index()
        a1.plot(100 * s.o, s.d, "o-", color=COLORS[run], label=run, lw=2, ms=4)
        if run == "default":
            for _, r in s.iterrows():
                a1.annotate(f"λ={r.lam:.0f}s", (100 * r.o, r.d), textcoords="offset points",
                            xytext=(6, 4), fontsize=8, color=COLORS[run])
        b = bud[bud.run == run].groupby("budget")
        a2.plot(100 * b.D.mean().index, b.D.mean().values, "o-", color=COLORS[run], label=run,
                lw=2, ms=4)
        if run == "default":
            a2.plot(100 * b.D_adj.mean().index, b.D_adj.mean().values, "o--", color=COLORS[run],
                    lw=1.5, ms=3, label=f"default, +{TURN_S:.0f}s per turn")
    a1.set(xlabel="mean extra travel time (%)", ylabel="mean capture sites passed per trip",
           title="Time vs. captures as the camera price λ rises")
    a2.set(xlabel="allowed extra travel time (%)", ylabel="mean capture sites passed per trip",
           title="Fewest captures within a time budget")
    for a in (a1, a2):
        a.grid(alpha=0.3)
        a.set_ylim(bottom=0)
        a.legend(frameon=False)
    fig.suptitle("Dallas, 300 random 3–25 km trips", fontsize=11)
    fig.tight_layout()
    fig.savefig(FIGURES / "tradeoff.png", dpi=150)
    plt.close(fig)


def plot_example(df, net, records, site_of, cams, ex, kept_routes, pairs) -> None:
    d = df[df.run == "default"]
    best = None
    for pair, g in d.groupby("pair"):
        g0 = g[g.lam == 0].iloc[0]
        alt = g[(g.lam > 0) & (g.overhead_adj <= 0.10)].sort_values(["D", "overhead_adj"]).head(1)
        if g0.D >= 4 and not alt.empty:
            gain = g0.D - alt.D.iloc[0]
            if best is None or gain > best[0]:
                best = (gain, pair, int(alt.lam.iloc[0]))
    if best is None:
        print("no showcase trip found")
        return
    _, pair, lam = best
    fast_e, alt_e = kept_routes[(0, pair)], kept_routes[(lam, pair)]
    fast_xy, alt_xy = net.geometry(fast_e), net.geometry(alt_e)
    pts = np.vstack([fast_xy, alt_xy])
    (x0, y0), (x1, y1) = pts.min(axis=0) - 700, pts.max(axis=0) + 700

    lo = {k: f.reduceat(net.geom_xy[:, i], net.offsets[:-1])
          for k, f, i in (("x", np.minimum, 0), ("X", np.maximum, 0), ("y", np.minimum, 1),
                          ("Y", np.maximum, 1))}
    vis = np.flatnonzero((lo["X"] >= x0) & (lo["x"] <= x1) & (lo["Y"] >= y0) & (lo["y"] <= y1))
    major = net.geom_hw[vis] <= 5  # motorway..primary_link

    fig, ax = plt.subplots(figsize=(9, 9 * (y1 - y0) / (x1 - x0)))
    for sel, lw, c in ((~major, 0.4, "#d4d4d4"), (major, 1.2, "#a9a9a9")):
        segs = [net.geom_xy[net.offsets[g]:net.offsets[g + 1]] for g in vis[sel]]
        ax.add_collection(LineCollection(segs, linewidths=lw, colors=c, zorder=1))
    ax.plot(*fast_xy.T, color="#d62728", lw=3, alpha=0.85, zorder=3)
    ax.plot(*alt_xy.T, color="#2a6fdb", lw=3, alpha=0.85, zorder=3)

    fast_s = set(distinct_sites(fast_e, ex).tolist())
    alt_s = set(distinct_sites(alt_e, ex).tolist())
    for i, cam in enumerate(cams):
        if not (x0 <= cam.x <= x1 and y0 <= cam.y <= y1):
            continue
        site = site_of[i]
        color = "#d62728" if site in fast_s else "#2a6fdb" if site in alt_s else "#555555"
        for bearing, _ in cam.sectors:
            marker = "o" if cam.mode == "any" else (3, 0, -bearing)
            ax.scatter(cam.x, cam.y, s=46 if color != "#555555" else 22, marker=marker,
                       color=color, edgecolors="white", linewidths=0.4, zorder=4)
    s, t = pairs[pair]
    ax.scatter(*net.node_xy[s], s=90, color="black", zorder=5, marker="s")
    ax.scatter(*net.node_xy[t], s=110, color="black", zorder=5, marker="*")

    r0 = d[(d.pair == pair) & (d.lam == 0)].iloc[0]
    r1 = d[(d.pair == pair) & (d.lam == lam)].iloc[0]
    ax.plot([], [], color="#d62728", lw=3,
            label=f"fastest: {r0['T'] / 60:.1f} min, {r0.D:.0f} capture sites")
    ax.plot([], [], color="#2a6fdb", lw=3,
            label=f"λ={lam}s: {r1['T'] / 60:.1f} min (+{100 * r1.overhead:.1f}%, "
                  f"+{100 * r1.overhead_adj:.1f}% with turns), {r1.D:.0f} capture sites")
    ax.scatter([], [], marker=(3, 0, 0), color="#555555", label="ALPR (triangle points where it looks)")
    ax.legend(loc="upper left", frameon=True, fontsize=9)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f"Dallas trip #{pair}: fastest vs. camera-avoiding route", fontsize=11)
    fig.tight_layout()
    fig.savefig(FIGURES / "example_route.png", dpi=150)
    plt.close(fig)

    print(f"\n== Example trip #{pair}: alerts along the fastest route ==")
    for dist, site in alerts(fast_e, net, ex):
        members = [i for i in np.flatnonzero(site_of == site)]
        brands = sorted({cams[i].brand or "(no brand)" for i in members})
        facing = sorted({f"{b:.0f}°" for i in members for b, _ in cams[i].sectors
                         if cams[i].mode != "any"})
        print(f"  {dist / 1000:5.2f} km  site of {len(members)} camera(s)  {', '.join(brands)}  "
              f"facing {'/'.join(facing) or 'unknown'}  e.g. osm node {records[members[0]]['id']}")


if __name__ == "__main__":
    main()
