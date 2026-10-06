"""Whether a rebuilt area's road pack replaces the one people have.

    unchanged  same fingerprint as the live pack: nothing to publish, phones keep theirs
    publish    a new area; the monthly rebuild; or, in the nightly update, roads that changed
               enough, or a live pack that's a week old
    defer      changed a little and the live pack is recent: it waits, so phones don't download
               an area again for every small fix
    hold       failed the checks (packages/router/src/verify.ts): the live pack stays

The checks compare the new pack with the live one, which the build fetches from the bucket. In a
dry run (no bucket) the new pack is checked on its own.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .pack import read_header

ROOT = Path(__file__).resolve().parents[1]
VERIFY = ROOT / "packages" / "router" / "bin" / "verify.ts"

#: In the nightly update, a changed area is republished when at least this share of its road
#: edges differ from the live pack's...
SIGNIFICANT_CHANGE = 0.01
#: ...or when its live pack is this many days old, so small fixes still arrive within a week.
MIN_DAYS_BETWEEN_UPDATES = 7

Verify = Callable[[Path, "Path | None"], dict]
FetchLive = Callable[[str, Path], bool]


@dataclass
class Decision:
    action: str  # "publish" | "unchanged" | "defer" | "hold"
    why: str
    verdict: dict | None = field(default=None)

    @property
    def changed(self) -> float | None:
        return (self.verdict or {}).get("changed")


def verify_with_node(fresh: Path, live: Path | None) -> dict:
    """Run the router's pack check (bin/verify.ts); its JSON verdict, or a failed one."""
    cmd = ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", str(VERIFY), str(fresh)]
    if live:
        cmd += ["--old", str(live)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {"ok": False, "reasons": [f"the pack check didn't run: {proc.stderr.strip()[-300:] or proc.returncode}"]}


def fetch_from_bucket(path: str, dest: Path) -> bool:
    """Copy a published file out of the bucket (needs R2_BUCKET and R2_ENDPOINT); False if it can't."""
    bucket, endpoint = os.environ.get("R2_BUCKET"), os.environ.get("R2_ENDPOINT")
    if not bucket or not endpoint:
        return False
    proc = subprocess.run(["aws", "s3", "cp", f"s3://{bucket}/{path}", str(dest), "--endpoint-url", endpoint,
                           "--only-show-errors"], capture_output=True, text=True)
    return proc.returncode == 0 and dest.exists()


def decide(region_id: str, pack: Path, live: dict | None, *, mode: str, now: dt.datetime,
           verify: Verify = verify_with_node, fetch_live: FetchLive = fetch_from_bucket) -> Decision:
    """`live` is the area's entry in the published regions.json, if it has one."""
    header = read_header(pack)
    live_pack = (live or {}).get("pack") or {}
    if live and header.get("fingerprint") and live_pack.get("fingerprint") == header["fingerprint"]:
        return Decision("unchanged", "same roads as the live pack")

    old = pack.with_name(f"{region_id}.live.fwr.gz") if live else None
    if old and not fetch_live(live_pack["path"], old):
        old = None
    try:
        verdict = verify(pack, old)
    finally:
        if old:
            old.unlink(missing_ok=True)
    if not verdict.get("ok"):
        return Decision("hold", "; ".join(verdict.get("reasons") or ["failed the checks"]), verdict)
    if not live:
        return Decision("publish", "a new area", verdict)
    if mode == "full":
        return Decision("publish", "monthly rebuild", verdict)

    changed = verdict.get("changed")
    if changed is not None and changed >= SIGNIFICANT_CHANGE:
        return Decision("publish", f"{changed:.1%} of road edges changed", verdict)
    built = live_pack.get("built_at")
    age = (now - dt.datetime.fromisoformat(built)).total_seconds() / 86400 if built else float("inf")
    if age >= MIN_DAYS_BETWEEN_UPDATES:
        return Decision("publish", f"changed, and the live pack is {age:.0f} days old", verdict)
    small = f"{changed:.2%} of road edges changed" if changed is not None else "changed"
    return Decision("defer", f"{small}; waits until the live pack is {MIN_DAYS_BETWEEN_UPDATES} days old", verdict)
