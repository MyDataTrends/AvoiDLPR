"""The road pack format (FWR1): what a device downloads per region.

    bytes 0-3   magic "FWR1"
    bytes 4-11  uint32 version, uint32 header length (header padded so data starts 8-aligned)
    header      UTF-8 JSON: metadata plus a section table {name, dtype, offset, length}
    data        little-endian arrays, each 8-aligned, offsets relative to the data start

Sections are flat typed arrays so a browser maps them with zero parsing. Geometry is
delta-coded micro-degrees (each geometry restarts absolute), which gzips well over HTTP.
Cameras are deliberately *not* in the pack: they change hourly and per user report, so the
device computes exposure itself from a separate camera feed.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .osm_graph import COORD_SCALE, HIGHWAY_CLASSES, SIGNAL_DELAY_S, RoadGraph

MAGIC = b"FWR1"
VERSION = 1
_DTYPES = {"uint8", "uint16", "int32", "uint32", "float32", "float64"}


def pack_sections(g: RoadGraph) -> dict[str, np.ndarray]:
    starts = g.geom_ptr[:-1]
    deltas = np.diff(g.geom_q, axis=0, prepend=np.zeros((1, 2), np.int64))
    deltas[starts] = g.geom_q[starts]
    centideg = lambda h: (np.round(h * 100).astype(np.int64) % 36000).astype(np.uint16)  # noqa: E731
    return {
        "geom_ptr": g.geom_ptr.astype(np.uint32),
        "geom_dlon": deltas[:, 0].astype(np.int32),
        "geom_dlat": deltas[:, 1].astype(np.int32),
        "node_out_ptr": g.out_ptr,
        "edge_dst": g.edge_dst.astype(np.uint32),
        "edge_geom": g.edge_geom.astype(np.uint32),
        "edge_flags": g.edge_rev.astype(np.uint8),  # bit 0: travels the geometry backwards
        "edge_time": g.edge_time.astype(np.float32),
        "edge_class": g.edge_class.astype(np.uint8),
        "edge_h0": centideg(g.edge_h0),
        "edge_h1": centideg(g.edge_h1),
        "ban_from": g.ban_from.astype(np.uint32),
        "ban_to": g.ban_to.astype(np.uint32),
    }


def pack_meta(g: RoadGraph, source: str, built_at: str) -> dict:
    lon, lat = g.geom_q[:, 0] / COORD_SCALE, g.geom_q[:, 1] / COORD_SCALE
    return {
        "format": "flockwatch-roads", "version": VERSION, "source": source, "built_at": built_at,
        "lat0": g.lat0, "lon0": g.lon0, "coord_scale": COORD_SCALE,
        "bbox": [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())],
        "counts": {"nodes": g.n_nodes, "edges": len(g.edge_src), "geoms": len(g.geom_ptr) - 1,
                   "verts": len(g.geom_q), "bans": len(g.ban_from)},
        "highway_classes": HIGHWAY_CLASSES, "signal_delay_s": SIGNAL_DELAY_S, "stats": g.stats,
    }


def write_pack(path: Path, meta: dict, sections: dict[str, np.ndarray]) -> int:
    table, blobs, offset = [], [], 0
    for name, arr in sections.items():
        arr = np.ascontiguousarray(arr)
        if arr.dtype.name not in _DTYPES:
            raise ValueError(f"{name}: unsupported dtype {arr.dtype}")
        pad = -offset % 8
        blobs.append(b"\0" * pad)
        offset += pad
        data = arr.astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        table.append({"name": name, "dtype": arr.dtype.name, "offset": offset, "length": int(arr.size)})
        blobs.append(data)
        offset += len(data)
    header = json.dumps({**meta, "sections": table}, separators=(",", ":")).encode()
    header += b" " * (-(12 + len(header)) % 8)
    # Write beside the target and rename over it: never half a pack, and a hard link to the old
    # file elsewhere keeps the old bytes.
    path = Path(path)
    tmp = path.with_name(path.name + ".partial")
    with open(tmp, "wb") as f:
        f.write(MAGIC)
        f.write(np.array([VERSION, len(header)], "<u4").tobytes())
        f.write(header)
        for blob in blobs:
            f.write(blob)
    tmp.replace(path)
    return 12 + len(header) + offset


def read_header(path: Path) -> dict:
    """Just the JSON header of a pack (metadata and section table), without loading the data."""
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != MAGIC:
            raise ValueError(f"{path}: not a road pack")
        version, hlen = (int(v) for v in np.frombuffer(head[4:12], "<u4"))
        if version != VERSION:
            raise ValueError(f"{path}: pack version {version}, expected {VERSION}")
        return json.loads(f.read(hlen))


def read_pack(path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    raw = Path(path).read_bytes()
    if raw[:4] != MAGIC:
        raise ValueError(f"{path}: not a road pack")
    version, hlen = (int(v) for v in np.frombuffer(raw[4:12], "<u4"))
    if version != VERSION:
        raise ValueError(f"{path}: pack version {version}, expected {VERSION}")
    meta = json.loads(raw[12:12 + hlen])
    base = 12 + hlen
    arrays = {s["name"]: np.frombuffer(raw, np.dtype(s["dtype"]).newbyteorder("<"), s["length"],
                                       base + s["offset"]) for s in meta["sections"]}
    return meta, arrays


def decode_vertices(arrays: dict[str, np.ndarray]) -> np.ndarray:
    """(v, 2) int64 micro-degrees (lon, lat) from the delta-coded geometry sections."""
    d = np.column_stack([arrays["geom_dlon"], arrays["geom_dlat"]]).astype(np.int64)
    starts = arrays["geom_ptr"][:-1].astype(np.int64)
    c = np.cumsum(d, axis=0)
    before = c[starts] - d[starts]  # running sum just before each geometry restarts
    geom_of = np.repeat(np.arange(len(starts)), np.diff(arrays["geom_ptr"].astype(np.int64)))
    return c - before[geom_of]
