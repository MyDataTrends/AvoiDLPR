"""Each state's roads, kept current: download once, then roll forward with Geofabrik's changes.

    work/roads/<extract>.osm.pbf     the state's drivable roads and turn restrictions
    work/roads/<extract>.state.json  {"server", "sequence", "timestamp"}: which change it holds

`fresh` downloads a state's extract and keeps the roads (`osmium tags-filter`). `update` applies
the change files Geofabrik has published since (a few megabytes a day per state, read with
pyosmium) and filters again: that's how the nightly build follows the map without downloading
every state again. The build workflow caches work/roads between runs.

One thing a filtered file can't do: a change that joins a road to a node only something else used
(a street extended to meet a footpath) leaves that road without the node, and the graph builder
drops it as incomplete. The monthly full build starts fresh and puts it back.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from pathlib import Path

import osmium
from osmium.replication.server import ReplicationServer

from .osm_graph import HIGHWAY_CLASSES
from .regions import geofabrik_url

Run = Callable[[Sequence[str]], None]

#: How much change to download in one go, in kB (pyosmium's unit): about three days of a big state.
MAX_DIFF_KB = 1_000_000


def slug(path: str) -> str:
    return path.replace("/", "_")


def roads_file(work: Path, path: str) -> Path:
    return work / "roads" / f"{slug(path)}.osm.pbf"


def state_file(work: Path, path: str) -> Path:
    return work / "roads" / f"{slug(path)}.state.json"


def download_command(url: str, target: Path) -> list[str]:
    return ["curl", "-fL", "--retry", "5", "--retry-delay", "10", "--retry-all-errors", "-o", str(target), url]


def filter_command(source: Path, target: Path) -> list[str]:
    return ["osmium", "tags-filter", str(source), f"w/highway={','.join(HIGHWAY_CLASSES)}", "r/type=restriction",
            "--overwrite", "-o", str(target)]


def replication_of(pbf: Path) -> dict | None:
    """The replication position in an extract's header (Geofabrik sets it), if there is one."""
    reader = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING)
    try:
        header = reader.header()
        seq = header.get("osmosis_replication_sequence_number")
        stamp = header.get("osmosis_replication_timestamp")
        url = header.get("osmosis_replication_base_url")
    finally:
        reader.close()
    return {"server": url, "sequence": int(seq), "timestamp": stamp} if seq and stamp and url else None


def read_state(work: Path, path: str) -> dict | None:
    f = state_file(work, path)
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def write_state(work: Path, path: str, state: dict) -> None:
    state_file(work, path).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def fresh(path: str, work: Path, run: Run, *, replication: Callable[[Path], dict | None] = replication_of) -> dict:
    """Download a state, keep its roads; returns its replication state (sequence 0 if unknown)."""
    raw = work / "src" / f"{slug(path)}.osm.pbf"
    roads = roads_file(work, path)
    raw.parent.mkdir(parents=True, exist_ok=True)
    roads.parent.mkdir(parents=True, exist_ok=True)
    if not raw.exists():
        run(download_command(geofabrik_url(path), raw))
    state = replication(raw) or {"server": None, "sequence": 0, "timestamp": None}
    run(filter_command(raw, roads))
    raw.unlink(missing_ok=True)  # the runner's disk is small; only the roads are needed
    write_state(work, path, state)
    return state


def update(path: str, work: Path, run: Run, *, server: Callable[[str], ReplicationServer] = ReplicationServer,
           replication: Callable[[Path], dict | None] = replication_of) -> tuple[dict, bool]:
    """Bring a state's roads up to date; returns (its replication state, whether anything changed).

    Without a cached copy, or one that can't be rolled forward (no replication position, or the
    changes since have been deleted from the server), it starts again from a fresh download.
    """
    roads, state = roads_file(work, path), read_state(work, path)
    if not roads.exists() or not state or not state.get("server") or not state.get("sequence"):
        return fresh(path, work, run, replication=replication), True
    repl = server(state["server"])
    latest = repl.get_state_info()
    if latest is None:
        raise RuntimeError(f"{path}: can't read the replication state at {state['server']}")
    if latest.sequence <= state["sequence"]:
        return state, False
    updated = roads.with_name(roads.name.replace(".osm.pbf", ".updated.osm.pbf"))
    while state["sequence"] < latest.sequence:  # a backlog bigger than MAX_DIFF_KB takes more than one pass
        updated.unlink(missing_ok=True)
        applied = repl.apply_diffs_to_file(str(roads), str(updated), state["sequence"] + 1, max_size=MAX_DIFF_KB)
        if applied is None:  # the changes we need aren't on the server any more
            updated.unlink(missing_ok=True)
            return fresh(path, work, run, replication=replication), True
        last, _newest = applied
        if int(last) <= state["sequence"]:
            raise RuntimeError(f"{path}: applying changes from {state['sequence'] + 1} made no progress")
        # pyosmium writes the position it reached (and its time) into the new file's header.
        state = replication(updated) or {"server": state["server"], "sequence": int(last), "timestamp": None}
        run(filter_command(updated, roads))  # drop the buildings and paths the changes brought in
        updated.unlink(missing_ok=True)
        write_state(work, path, state)
    return state, True
