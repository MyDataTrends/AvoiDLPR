"""An area's place index for the app's search: streets, house numbers and named places.

Usage: python -m pipeline.places <extract.osm.pbf> <out.fwp> [--osm-at TIME]

Search runs on the phone, like routing, so what someone looks for never leaves it. This builds
what it searches, from OpenStreetMap:

  streets    every named road. A street's pieces make one entry, with a point about every
             kilometre along it (the app shows the one nearest you); the same name in two towns,
             far apart, stays two entries.
  addresses  house numbers, filed under their street, at the address point or the middle of the
             building that carries one
  places     named destinations: shops, restaurants, schools, parks, hospitals, stations,
             airports, and town and neighbourhood names (`kind_of` decides what counts)

Streets and places carry a town for telling them apart: the one their addresses give most often,
else the nearest town or city in the data.

The format (FWP1) follows the road pack's: magic, version, a JSON header with a section table,
then 8-aligned little-endian arrays. Each string is stored once, UTF-8, behind an offset table.
Coordinates are micro-degrees. Addresses are sorted by street and number and their coordinates
delta-coded, which is what makes the file gzip small.

The input wants named objects, addresses and the multipolygons of named places, with their nodes:
`places_filter_command` makes that from a state extract.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import osmium
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from .osm_graph import HIGHWAY_CLASSES

MAGIC = b"FWP1"
VERSION = 1
COORD_SCALE = 1_000_000  # micro-degrees, while building
#: The file's coordinates are in 1e-5 degrees (about a metre): plenty for a destination, and
#: address coordinates gzip a third smaller than in micro-degrees.
FILE_SCALE = 100_000
NONE = 0xFFFFFFFF  # "no string" in a string column
#: Pieces of a street with the same name this close together (metres) are one street; for a
#: major road, whose name often lapses at bridges and interchanges, further apart.
STREET_JOIN_M = 400
MAJOR_JOIN_M = 2000
MAJOR_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link"}
#: A long street gets a point about this often (metres), so the app can show the stretch near you.
STREET_POINT_M = 1000
#: An address further than this from every street of its name gets a street entry of its own.
ADDRESS_STREET_M = 1500
#: The same number on the same street this close together is one address (a node and a building).
SAME_ADDRESS_M = 60
#: Towns name things within this distance (a town node's reach, scaled by its weight below).
TOWN_REACH_M = 15_000
TOWN_WEIGHT = {"city": 2.5, "town": 1.5, "village": 1.0}

# What a named object is, from its tags: (key, values or None for any, label, rank). The first
# match wins. Labels default to the value in words; rank (0-3) lifts a result in the app.
_KINDS: list[tuple[str, frozenset[str] | None, str | None, int]] = [
    ("place", frozenset({"city", "town"}), None, 3),
    ("place", frozenset({"village", "suburb", "borough", "quarter", "neighbourhood", "hamlet", "locality"}), None, 2),
    ("aeroway", frozenset({"aerodrome"}), "Airport", 1),  # 3 with an airline code: see kind_of
    ("aeroway", frozenset({"terminal"}), "Airport terminal", 2),
    ("railway", frozenset({"station", "halt", "stop"}), "Station", 2),
    ("railway", frozenset({"tram_stop"}), "Station", 1),
    ("public_transport", frozenset({"station"}), "Station", 2),
    ("amenity", frozenset({"hospital"}), None, 3),
    ("amenity", frozenset({"university", "college"}), None, 2),
    ("leisure", frozenset({"stadium"}), None, 3),
    ("shop", frozenset({"mall"}), None, 2),
    ("amenity", None, None, 1),
    ("shop", None, None, 1),
    ("tourism", None, None, 1),
    ("leisure", None, None, 1),
    ("healthcare", None, None, 1),
    ("landuse", frozenset({"retail"}), "Shopping center", 2),
    ("landuse", frozenset({"religious"}), "Place of worship", 1),
    ("landuse", frozenset({"commercial"}), "Business park", 0),
    ("landuse", frozenset({"cemetery"}), "Cemetery", 0),
    ("natural", frozenset({"water"}), "Lake", 1),  # not rivers: see kind_of
    ("office", None, None, 0),
    ("craft", None, None, 0),
    ("building", None, "Building", 0),
]
#: Tagged things nobody looks up by name.
_SKIP = {
    "amenity": {"bench", "waste_basket", "parking_space", "parking_entrance", "bicycle_parking", "vending_machine",
                "toilets", "drinking_water", "post_box", "shelter", "recycling", "waste_disposal", "telephone",
                "clock", "fountain", "grit_bin", "hunting_stand", "atm", "bbq", "letter_box", "lounger",
                "loading_dock", "watering_place", "water_point", "smoking_area", "dog_toilet", "give_box"},
    "leisure": {"picnic_table", "swimming_pool", "pitch", "track", "garden", "playground", "firepit",
                "outdoor_seating", "slipway", "fitness_station", "bleachers", "dog_park"},
    "tourism": {"information", "artwork", "picnic_site", "viewpoint"},
}
#: When the value says nothing ("yes") or isn't a plain word.
_GENERIC = {"place": "Place", "amenity": "Place", "shop": "Shop", "tourism": "Attraction", "leisure": "Leisure",
            "healthcare": "Health care", "office": "Office", "craft": "Business", "building": "Building"}
#: Labels that read better than the tag value.
_LABELS = {
    "fuel": "Gas station", "fast_food": "Fast food", "place_of_worship": "Place of worship", "townhall": "Town hall",
    "supermarket": "Grocery store", "car_wash": "Car wash", "car_repair": "Car repair", "doityourself": "Hardware store",
    "charging_station": "EV charging", "ice_cream": "Ice cream", "fire_station": "Fire station",
    "post_office": "Post office", "social_facility": "Social services", "community_centre": "Community center",
    "sports_centre": "Sports center", "fitness_centre": "Gym", "neighbourhood": "Neighborhood",
    "golf_course": "Golf course", "nature_reserve": "Nature reserve", "theme_park": "Theme park",
    "convenience": "Convenience store", "department_store": "Department store", "mall": "Mall", "cafe": "Café",
    "events_venue": "Event venue", "arts_centre": "Arts center", "car": "Car dealer", "hairdresser": "Hair salon",
    "veterinary": "Vet", "kindergarten": "Preschool", "childcare": "Child care", "locality": "Area",
    "quarter": "Neighborhood", "suburb": "Neighborhood", "hamlet": "Community", "chemist": "Drugstore",
}
#: Alternative names a search should also find (the app shows the main name).
_ALT_KEYS = ("short_name", "alt_name", "official_name", "old_name", "iata", "brand")
_WORD = re.compile(r"^[a-z_]+$")


def _label(key: str, value: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    if value in _LABELS:
        return _LABELS[value]
    if value == "yes" or not _WORD.match(value):
        return _GENERIC[key]
    words = value.replace("_", " ")
    return words[:1].upper() + words[1:]


def kind_of(tags) -> tuple[str, int] | None:
    """(label, rank) of a named object worth finding, or None."""
    for key, values, label, rank in _KINDS:
        value = tags.get(key)
        if value is None or value == "no":
            continue
        if values is not None and value not in values:
            continue
        if value in _SKIP.get(key, ()):
            return None
        if key == "natural" and tags.get("water", "lake") not in ("lake", "reservoir", "pond", "lagoon"):
            return None
        if key == "aeroway" and value == "aerodrome" and tags.get("iata"):
            rank = 3  # an airport with airline service, not an airstrip or a helipad
        return _label(key, value, label), rank
    if tags.get("addr:housenumber"):
        return "Place", 0  # a named address: a business tagged with little else
    return None


# Street names in addresses are written every which way ("E Belt Line Rd" for a road named "East
# Belt Line Road"), so streets are matched on a key with one spelling of each USPS abbreviation.
_SHORT = {
    "street": "st", "saint": "st", "avenue": "ave", "av": "ave", "road": "rd", "drive": "dr", "boulevard": "blvd",
    "lane": "ln", "court": "ct", "place": "pl", "parkway": "pkwy", "pky": "pkwy", "highway": "hwy", "freeway": "fwy",
    "expressway": "expy", "circle": "cir", "terrace": "ter", "trail": "trl", "square": "sq", "cove": "cv",
    "crossing": "xing", "point": "pt", "mount": "mt", "fort": "ft", "heights": "hts", "junction": "jct", "loop": "lp",
    "plaza": "plz", "alley": "aly", "bypass": "byp", "creek": "crk", "estates": "ests", "grove": "grv",
    "harbor": "hbr", "hollow": "holw", "meadow": "mdw", "meadows": "mdws", "ridge": "rdg", "springs": "spgs",
    "spring": "spg", "turnpike": "tpke", "trace": "trce", "valley": "vly", "view": "vw", "vista": "vis",
    "north": "n", "south": "s", "east": "e", "west": "w", "northeast": "ne", "northwest": "nw", "southeast": "se",
    "southwest": "sw",
}
_DIRECTIONS = {"n", "s", "e", "w", "ne", "nw", "se", "sw"}
_TYPES = {"st", "ave", "rd", "dr", "blvd", "ln", "ct", "pl", "pkwy", "hwy", "fwy", "expy", "cir", "ter", "trl", "sq",
          "cv", "xing", "pt", "lp", "plz", "aly", "byp", "way", "run", "row", "pass", "path", "pike", "walk"}


def street_key(name: str) -> str:
    """A street's matching key: "E Belt Line Rd" and "East Belt Line Road" are one street."""
    words = re.sub(r"[^\w\s]", " ", name.lower()).split()
    return " ".join(_SHORT.get(w, w) for w in words)


def loose_keys(key: str) -> tuple[str, str]:
    """Looser keys, for an address's street that matches no road: without the direction ("belt
    line rd" for "e belt line rd"), and without the type too ("abrams" for "abrams rd")."""
    words = key.split()
    while len(words) > 1 and words[0] in _DIRECTIONS:
        words = words[1:]
    while len(words) > 1 and words[-1] in _DIRECTIONS:
        words = words[:-1]
    bare = " ".join(words)
    return bare, " ".join(words[:-1]) if len(words) > 1 and words[-1] in _TYPES else bare


def _tidy(text: str | None, *, shouting: bool = False) -> str | None:
    """A free-text tag, trimmed; with `shouting`, ALL CAPS becomes Title Case (town names are
    sometimes imported that way; shop names like IHOP are meant to be)."""
    if not text:
        return None
    text = re.sub(r"\s+", " ", re.sub("[​-‍⁠﻿]", "", text)).strip()
    if not text:
        return None
    return text.title() if shouting and text.isupper() and len(text) > 3 else text


def plausible_street(name: str) -> bool:
    """An address's street that reads like a street name, not a whole address or a number."""
    words = name.split()
    return bool(re.search(r"[^\W\d_]", name)) and "," not in name and not (len(words) > 1 and words[0].isdigit())


@dataclass
class Index:
    strings: list[str]
    street_name: np.ndarray  # u32 string ids
    street_town: np.ndarray
    street_pt_ptr: np.ndarray  # u32, len streets + 1
    street_pt_xy: np.ndarray  # (k, 2) micro-degrees
    street_addr_ptr: np.ndarray  # u32, len streets + 1: addresses are sorted by street, then number
    addr_lead: np.ndarray  # the number an address starts with ("12" for "12B"), 0 for none
    addr_text_at: np.ndarray  # u32: the addresses whose number is more than digits ("12B", "4-6")...
    addr_text: np.ndarray  # u32: ...and that text's string id
    addr_xy: np.ndarray
    place_name: np.ndarray
    place_alt: np.ndarray
    place_kind: np.ndarray  # u16 index into `kinds`
    place_town: np.ndarray
    place_xy: np.ndarray
    kinds: list[tuple[str, int]]
    bbox: list[float]
    stats: dict


class _Collector:
    """What a place index needs from one pass over an extract."""

    def __init__(self, wanted_ways: set[int]) -> None:
        self.wanted_ways = wanted_ways  # members of named multipolygons: their nodes, for a centre
        self.way_xy: dict[int, np.ndarray] = {}
        self.street_pieces: dict[str, list[np.ndarray]] = defaultdict(list)
        self.street_spelling: dict[str, Counter] = defaultdict(Counter)
        self.major: set[str] = set()  # street keys that are (partly) major roads
        # number, street (as tagged), town, x, y
        self.addresses: list[tuple[str, str, str | None, int, int]] = []
        # name, alt, label, rank, town, x, y
        self.places: list[tuple[str, str | None, str, int, str | None, int, int]] = []
        self.towns: list[tuple[str, float, int, int]] = []  # name, weight, x, y
        self.stats: Counter = Counter()

    def node(self, n) -> None:
        tags = n.tags
        if not tags:
            return
        x, y = round(n.location.lon * COORD_SCALE), round(n.location.lat * COORD_SCALE)
        if tags.get("place") in TOWN_WEIGHT and tags.get("name"):
            self.towns.append((tags["name"], TOWN_WEIGHT[tags["place"]], x, y))
        self.tagged(tags, x, y)

    def way(self, w) -> None:
        tags = w.tags
        name = tags.get("name")
        street = name and tags.get("highway") in HIGHWAY_CLASSES and tags.get("area") != "yes"
        wanted = w.id in self.wanted_ways
        if not (street or wanted or name or tags.get("brand") or tags.get("addr:housenumber")):
            return
        try:
            xy = np.array([(round(n.lon * COORD_SCALE), round(n.lat * COORD_SCALE)) for n in w.nodes], np.int64)
        except osmium.InvalidLocationError:
            self.stats["ways_missing_nodes"] += 1
            return
        if len(xy) == 0:
            return
        if wanted:
            self.way_xy[w.id] = xy
        if street:
            key = street_key(name)
            self.street_pieces[key].append(xy)
            self.street_spelling[key][name.strip()] += 1
            if tags.get("highway") in MAJOR_ROADS:
                self.major.add(key)
            return
        cx, cy = _centre(xy)
        self.tagged(tags, cx, cy)

    def tagged(self, tags, x: int, y: int) -> None:
        number = tags.get("addr:housenumber")
        street = _tidy(tags.get("addr:street") or tags.get("addr:place"))
        town = _tidy(tags.get("addr:city"), shouting=True)
        if number and street:
            for n in number.split(";"):
                if n.strip():
                    self.addresses.append((n.strip(), street, town, x, y))
        name = _tidy(tags.get("name")) or _tidy(tags.get("brand"))
        if not name:
            return
        kind = kind_of(tags)
        if kind is None:
            self.stats["named_other"] += 1
            return
        self.places.append((name, _alt(tags, name), kind[0], kind[1], town, x, y))


def _alt(tags, name: str) -> str | None:
    """Other names a search should match, joined; none that the main name already contains."""
    seen, out = name.lower(), []
    for key in _ALT_KEYS:
        for v in (tags.get(key) or "").split(";"):
            v = v.strip()
            if v and v.lower() not in seen:
                out.append(v)
                seen += " " + v.lower()
    return " · ".join(out) or None


def _centre(xy: np.ndarray) -> tuple[int, int]:
    """The middle of a way's (or a ring's) bounding box: robust to unevenly spaced vertices."""
    return int((xy[:, 0].min() + xy[:, 0].max()) // 2), int((xy[:, 1].min() + xy[:, 1].max()) // 2)


def _relations(path: Path) -> tuple[list[tuple], set[int]]:
    """Named multipolygon places and the ways they're made of (the first pass: relations only)."""
    found, ways = [], set()
    for r in osmium.FileProcessor(str(path), osmium.osm.RELATION):
        tags = r.tags
        if tags.get("type") != "multipolygon":
            continue
        name = _tidy(tags.get("name")) or _tidy(tags.get("brand"))
        kind = kind_of(tags) if name else None
        if not kind:
            continue
        members = [m.ref for m in r.members if m.type == "w" and m.role != "inner"]
        if members:
            found.append((name, _alt(tags, name), kind, _tidy(tags.get("addr:city"), shouting=True), members))
            ways.update(members)
    return found, ways


class _Metres:
    """Micro-degrees to local metres (one scale for the whole area: fine across a metro)."""

    def __init__(self, lat: float) -> None:
        self.ky = 111_320.0 / COORD_SCALE
        self.kx = self.ky * math.cos(math.radians(lat))

    def __call__(self, xy: np.ndarray) -> np.ndarray:
        return np.column_stack([xy[:, 0] * self.kx, xy[:, 1] * self.ky])


def _components(points_m: np.ndarray, owner: np.ndarray, n_owners: int, join_m: float) -> np.ndarray:
    """A group label per owner: owners (a street's pieces, or single addresses) whose points come
    within `join_m` of each other share one. Points are thinned to one per 50 m cell per owner first."""
    if n_owners == 1:
        return np.zeros(1, np.int64)
    cells = np.floor(points_m / 50).astype(np.int64)
    _, keep = np.unique(np.column_stack([owner, cells]), axis=0, return_index=True)
    pts, own = points_m[keep], owner[keep]
    pairs = cKDTree(pts).query_pairs(join_m, output_type="ndarray")
    graph = coo_matrix((np.ones(len(pairs), np.int8), (own[pairs[:, 0]], own[pairs[:, 1]])), shape=(n_owners, n_owners))
    return connected_components(graph, directed=False)[1]


def _sample(points_m: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """About one point per STREET_POINT_M cell the street passes through: the middle one of each."""
    cells = np.floor(points_m / STREET_POINT_M).astype(np.int64)
    order = np.lexsort((np.arange(len(cells)), cells[:, 1], cells[:, 0]))
    c = cells[order]
    starts = np.flatnonzero(np.r_[True, (c[1:] != c[:-1]).any(axis=1)])
    ends = np.r_[starts[1:], len(c)]
    return xy[order[(starts + ends) // 2]]


def _spelling(spellings: Counter) -> str:
    """How to write a street only addresses name: the commonest spelling that isn't in capitals
    ("LBJ Freeway" over "LBJ FREEWAY"), else the commonest, in title case."""
    for name, _ in spellings.most_common():
        if not name.isupper():
            return name
    return _tidy(spellings.most_common(1)[0][0], shouting=True)


def _number_key(n: str) -> tuple[int, str]:
    """(the number it starts with, or 0; the text): how addresses sort along a street."""
    m = re.match(r"\d{1,9}", n)
    return (int(m.group()) if m else 0, n)


class _Towns:
    """The town that names a point: the nearest town node, weighted so a city reaches further."""

    def __init__(self, towns: list[tuple[str, float, int, int]], metres: _Metres) -> None:
        self.names = [t[0] for t in towns]
        self.weight = np.array([t[1] for t in towns])
        self.tree = cKDTree(metres(np.array([(t[2], t[3]) for t in towns], np.int64))) if towns else None
        self.metres = metres

    def near(self, xy: np.ndarray) -> list[str | None]:
        if self.tree is None or len(xy) == 0:
            return [None] * len(xy)
        k = min(8, len(self.names))
        d, i = self.tree.query(self.metres(xy), k=k, distance_upper_bound=TOWN_REACH_M * max(TOWN_WEIGHT.values()))
        d, i = d.reshape(len(xy), k), i.reshape(len(xy), k)
        out: list[str | None] = []
        for row_d, row_i in zip(d, i, strict=True):
            best, best_score = None, math.inf
            for dist, idx in zip(row_d, row_i, strict=True):
                if idx >= len(self.names):
                    continue
                score = dist / self.weight[idx]
                if score < best_score and score <= TOWN_REACH_M:
                    best, best_score = self.names[idx], score
            out.append(best)
        return out


def build_index(path: str | Path) -> Index:
    path = Path(path)
    rel_places, wanted = _relations(path)
    col = _Collector(wanted)
    for obj in osmium.FileProcessor(str(path), osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if obj.is_node():
            col.node(obj)
        else:
            col.way(obj)
    for name, alt, (label, rank), town, members in rel_places:
        rings = [col.way_xy[m] for m in members if m in col.way_xy]
        if not rings:
            col.stats["relations_missing_ways"] += 1
            continue
        x, y = _centre(np.concatenate(rings))
        col.places.append((name, alt, label, rank, town, x, y))

    everything = [xy for pieces in col.street_pieces.values() for xy in pieces]
    everything += [np.array([[a[3], a[4]] for a in col.addresses] or np.zeros((0, 2)), np.int64)]
    everything += [np.array([[p[5], p[6]] for p in col.places] or np.zeros((0, 2)), np.int64)]
    allxy = np.concatenate(everything) if everything else np.zeros((0, 2), np.int64)
    if len(allxy) == 0:
        raise ValueError(f"{path}: no streets, addresses or places in it")
    metres = _Metres(float(np.median(allxy[:, 1])) / COORD_SCALE)
    towns = _Towns(col.towns, metres)

    # ---- streets: each name's pieces, grouped into streets by distance
    streets: list[dict] = []  # {name, points}
    # Per name: its street ids, and its vertices (thinned to one per 100 m) with the street of each.
    by_key: dict[str, tuple[list[int], np.ndarray, np.ndarray]] = {}
    for key in sorted(col.street_pieces):
        pieces = col.street_pieces[key]
        xy = np.concatenate(pieces)
        m = metres(xy)
        piece_of = np.repeat(np.arange(len(pieces)), [len(p) for p in pieces])
        group_of_piece = _components(m, piece_of, len(pieces), MAJOR_JOIN_M if key in col.major else STREET_JOIN_M)
        vertex_group = group_of_piece[piece_of]
        ids = []
        for g in range(int(group_of_piece.max()) + 1):
            sel = vertex_group == g
            ids.append(len(streets))
            streets.append({"name": col.street_spelling[key].most_common(1)[0][0], "points": _sample(m[sel], xy[sel])})
        _, keep = np.unique(np.column_stack([vertex_group, np.floor(m / 100).astype(np.int64)]), axis=0, return_index=True)
        by_key[key] = (ids, m[keep], vertex_group[keep])

    # ---- addresses: to the nearest street of their name, or a street of their own. A name that
    # matches no road nearby is tried again without its direction, then without its type too.
    addr = col.addresses
    addr_street = np.full(len(addr), -1, np.int64)
    by_name: dict[str, list[int]] = defaultdict(list)
    for i, a in enumerate(addr):
        by_name[street_key(a[1])].append(i)
    looser: list[dict[str, list[str]]] = [defaultdict(list), defaultdict(list)]
    for key in by_key:
        for level, variant in enumerate(loose_keys(key)):
            looser[level][variant].append(key)
    trees: dict[str, cKDTree] = {}
    orphans: dict[str, list[int]] = {}
    for key, members in by_name.items():
        idx = np.array(members)
        pts = metres(np.array([[addr[i][3], addr[i][4]] for i in members], np.int64))
        variants = loose_keys(key)
        for level, candidates in enumerate([[key] if key in by_key else [], looser[0].get(variants[0], []),
                                            looser[1].get(variants[1], [])]):
            if not len(idx) or not candidates:
                continue
            best_d = np.full(len(idx), np.inf)
            best_street = np.full(len(idx), -1, np.int64)
            for cand in candidates:
                ids, vertices, vertex_group = by_key[cand]
                if cand not in trees:
                    trees[cand] = cKDTree(vertices)
                d, v = trees[cand].query(pts)
                better = d < best_d
                best_d[better] = d[better]
                best_street[better] = np.array(ids)[vertex_group[v[better]]]
            near = best_d <= ADDRESS_STREET_M
            addr_street[idx[near]] = best_street[near]
            if level:
                col.stats["addresses_matched_loosely"] += int(near.sum())
            idx, pts = idx[~near], pts[~near]
        if len(idx):
            if plausible_street(addr[idx[0]][1]):
                orphans[key] = list(idx)
            else:
                col.stats["addresses_without_a_street"] += len(idx)
    for key in sorted(orphans):
        members = np.array(orphans[key])
        xy = np.array([[addr[i][3], addr[i][4]] for i in members], np.int64)
        m = metres(xy)
        groups = _components(m, np.arange(len(members)), len(members), STREET_JOIN_M)
        for g in range(int(groups.max()) + 1):
            sel = groups == g
            spelling = _spelling(Counter(addr[i][1] for i in members[sel]))
            addr_street[members[sel]] = len(streets)
            streets.append({"name": spelling, "points": _sample(m[sel], xy[sel])})
            col.stats["streets_from_addresses"] += 1

    keep_addr = addr_street >= 0  # the rest had no street worth the name

    # A street's town: what its addresses say most often, else the nearest town to its middle point.
    said: dict[int, Counter] = defaultdict(Counter)
    for i, a in enumerate(addr):
        if a[2] and keep_addr[i]:
            said[int(addr_street[i])][a[2]] += 1
    middles = np.array([s["points"][len(s["points"]) // 2] for s in streets], np.int64).reshape(-1, 2)
    nearest = towns.near(middles)
    street_town = [said[i].most_common(1)[0][0] if said[i] else nearest[i] for i in range(len(streets))]

    # One entry per street and number, unless the same number turns up well apart (two buildings).
    order = sorted(np.flatnonzero(keep_addr).tolist(),
                   key=lambda i: (addr_street[i], _number_key(addr[i][0]), addr[i][3], addr[i][4]))
    kept: list[int] = []
    for i in order:
        if kept:
            j = kept[-1]
            if addr_street[j] == addr_street[i] and addr[j][0].lower() == addr[i][0].lower():
                d = metres(np.array([[addr[i][3] - addr[j][3], addr[i][4] - addr[j][4]]], np.int64))
                if math.hypot(*d[0]) < SAME_ADDRESS_M:
                    col.stats["duplicate_addresses"] += 1
                    continue
        kept.append(i)

    # ---- places: drop repeats (a shop mapped as a point and as its building)
    seen: set[tuple[str, int, int]] = set()
    places = []
    for p in col.places:
        key = (p[0].lower(), p[5] // 2000, p[6] // 2000)  # ~200 m cells
        if key in seen:
            col.stats["duplicate_places"] += 1
            continue
        seen.add(key)
        places.append(p)
    places.sort(key=lambda p: (p[0].lower(), p[5], p[6]))
    place_xy = np.array([[p[5], p[6]] for p in places], np.int64).reshape(-1, 2)
    nearest = towns.near(place_xy)
    kinds = sorted({(p[2], p[3]) for p in places})
    kind_id = {k: i for i, k in enumerate(kinds)}

    # ---- strings, shared
    strings: list[str] = []
    ids: dict[str, int] = {}

    def sid(s: str | None) -> int:
        if not s:
            return NONE
        if s not in ids:
            ids[s] = len(strings)
            strings.append(s)
        return ids[s]

    street_counts = np.bincount(addr_street[kept], minlength=len(streets)) if kept else np.zeros(len(streets), np.int64)
    ix = Index(
        strings=strings,
        street_name=np.array([sid(s["name"]) for s in streets], np.uint32),
        street_town=np.array([sid(t) for t in street_town], np.uint32),
        street_pt_ptr=np.concatenate([[0], np.cumsum([len(s["points"]) for s in streets])]).astype(np.uint32),
        street_pt_xy=np.concatenate([s["points"] for s in streets]) if streets else np.zeros((0, 2), np.int64),
        street_addr_ptr=np.concatenate([[0], np.cumsum(street_counts)]).astype(np.uint32),
        addr_lead=np.array([_number_key(addr[i][0])[0] for i in kept], np.int64),
        addr_text_at=np.array([k for k, i in enumerate(kept) if str(_number_key(addr[i][0])[0]) != addr[i][0]], np.uint32),
        addr_text=np.array([sid(addr[i][0]) for i in kept if str(_number_key(addr[i][0])[0]) != addr[i][0]], np.uint32),
        addr_xy=np.array([[addr[i][3], addr[i][4]] for i in kept], np.int64).reshape(-1, 2),
        place_name=np.array([sid(p[0]) for p in places], np.uint32),
        place_alt=np.array([sid(p[1]) for p in places], np.uint32),
        place_kind=np.array([kind_id[(p[2], p[3])] for p in places], np.uint16),
        place_town=np.array([sid(_town_of(p, nearest[i])) for i, p in enumerate(places)], np.uint32),
        place_xy=place_xy,
        kinds=kinds,
        bbox=[round(float(allxy[:, 0].min()) / COORD_SCALE, 6), round(float(allxy[:, 1].min()) / COORD_SCALE, 6),
              round(float(allxy[:, 0].max()) / COORD_SCALE, 6), round(float(allxy[:, 1].max()) / COORD_SCALE, 6)],
        stats=dict(sorted(col.stats.items())),
    )
    return ix


def _town_of(place: tuple, nearest: str | None) -> str | None:
    """A place's town, unless it is one (a town node's nearest town is itself)."""
    town = place[4] or nearest
    return None if place[2] in ("City", "Town") or (town and town.lower() == place[0].lower()) else town


def _file_xy(xy: np.ndarray) -> np.ndarray:
    """Micro-degrees to the file's units."""
    return np.round(xy / (COORD_SCALE // FILE_SCALE)).astype(np.int64).reshape(-1, 2)


def _deltas(values: np.ndarray, starts: np.ndarray | None = None) -> np.ndarray:
    """Each value minus the one before it (along axis 0); at `starts`, the value itself."""
    d = np.diff(values, axis=0, prepend=np.zeros((1, *values.shape[1:]), values.dtype))
    if starts is not None:
        d[starts] = values[starts]
    return d.astype(np.int32)


def sections(ix: Index) -> dict[str, np.ndarray]:
    blob = [s.encode("utf-8") for s in ix.strings]
    addr_d = _deltas(_file_xy(ix.addr_xy))
    ptr = ix.street_addr_ptr.astype(np.int64)
    first = np.zeros(len(ix.addr_lead), bool)  # the first address of each street
    first[ptr[:-1][ptr[:-1] < ptr[1:]]] = True
    street_xy, place_xy = _file_xy(ix.street_pt_xy), _file_xy(ix.place_xy)
    return {
        "text_ptr": np.concatenate([[0], np.cumsum([len(b) for b in blob], dtype=np.int64)]).astype(np.uint32),
        "text": np.frombuffer(b"".join(blob), np.uint8),
        "street_name": ix.street_name, "street_town": ix.street_town,
        "street_pt_ptr": ix.street_pt_ptr,
        "street_pt_lon": street_xy[:, 0].astype(np.int32), "street_pt_lat": street_xy[:, 1].astype(np.int32),
        "street_addr_ptr": ix.street_addr_ptr,
        # Numbers rise along each street: stored as steps from the one before, restarting per street.
        "addr_num": _deltas(ix.addr_lead, first), "addr_text_at": ix.addr_text_at, "addr_text": ix.addr_text,
        "addr_dlon": addr_d[:, 0], "addr_dlat": addr_d[:, 1],
        "place_name": ix.place_name, "place_alt": ix.place_alt, "place_kind": ix.place_kind, "place_town": ix.place_town,
        "place_lon": place_xy[:, 0].astype(np.int32), "place_lat": place_xy[:, 1].astype(np.int32),
    }


def counts(ix: Index) -> dict[str, int]:
    return {"streets": len(ix.street_name), "addresses": len(ix.addr_lead), "places": len(ix.place_name)}


def fingerprint(ix: Index, secs: dict[str, np.ndarray]) -> str:
    """Identifies the index's contents (not when it was built): an unchanged index keeps its file."""
    h = hashlib.sha256(json.dumps([ix.kinds, VERSION], separators=(",", ":")).encode())
    for name, arr in secs.items():
        h.update(name.encode())
        h.update(np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tobytes())
    return h.hexdigest()[:16]


def write_index(path: Path, ix: Index, *, built_at: str, osm_at: str | None = None) -> int:
    secs = sections(ix)
    table, blobs, offset = [], [], 0
    for name, arr in secs.items():
        pad = -offset % 8
        blobs.append(b"\0" * pad)
        offset += pad
        data = np.ascontiguousarray(arr).astype(arr.dtype.newbyteorder("<"), copy=False).tobytes()
        table.append({"name": name, "dtype": arr.dtype.name, "offset": offset, "length": int(arr.size)})
        blobs.append(data)
        offset += len(data)
    meta = {
        "format": "avoidlpr-places", "version": VERSION, "built_at": built_at, **({"osm_at": osm_at} if osm_at else {}),
        "fingerprint": fingerprint(ix, secs), "coord_scale": FILE_SCALE, "bbox": ix.bbox,
        "kinds": [{"label": label, "rank": rank} for label, rank in ix.kinds],
        "counts": counts(ix), "stats": ix.stats, "sections": table,
    }
    header = json.dumps(meta, separators=(",", ":")).encode()
    header += b" " * (-(12 + len(header)) % 8)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
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
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != MAGIC:
            raise ValueError(f"{path}: not a place index")
        return json.loads(f.read(int(np.frombuffer(head[8:12], "<u4")[0])))


def read_index(path: Path) -> tuple[dict, dict[str, np.ndarray]]:
    raw = Path(path).read_bytes()
    if raw[:4] != MAGIC:
        raise ValueError(f"{path}: not a place index")
    hlen = int(np.frombuffer(raw[8:12], "<u4")[0])
    meta = json.loads(raw[12:12 + hlen])
    base = 12 + hlen
    arrays = {s["name"]: np.frombuffer(raw, np.dtype(s["dtype"]).newbyteorder("<"), s["length"], base + s["offset"])
              for s in meta["sections"]}
    return meta, arrays


def entries(path: Path) -> dict[str, list[dict]]:
    """A place index decoded into plain Python: for tests and for looking one over."""
    meta, a = read_index(path)
    ptr, blob, scale = a["text_ptr"], a["text"].tobytes(), meta["coord_scale"]
    text = lambda i: None if i == NONE else blob[ptr[i]:ptr[i + 1]].decode()  # noqa: E731
    lon, lat = np.cumsum(a["addr_dlon"].astype(np.int64)), np.cumsum(a["addr_dlat"].astype(np.int64))
    texts = {int(k): text(t) for k, t in zip(a["addr_text_at"], a["addr_text"], strict=True)}
    pp, ap = a["street_pt_ptr"].astype(np.int64), a["street_addr_ptr"].astype(np.int64)
    streets = []
    for i in range(len(a["street_name"])):
        lead = np.cumsum(a["addr_num"][ap[i]:ap[i + 1]].astype(np.int64))
        streets.append({
            "name": text(a["street_name"][i]), "town": text(a["street_town"][i]),
            "points": [(a["street_pt_lon"][k] / scale, a["street_pt_lat"][k] / scale) for k in range(pp[i], pp[i + 1])],
            "addresses": [(texts.get(k, str(int(lead[k - ap[i]]))), lon[k] / scale, lat[k] / scale)
                          for k in range(ap[i], ap[i + 1])],
        })
    places = [{"name": text(a["place_name"][i]), "alt": text(a["place_alt"][i]),
               "kind": meta["kinds"][a["place_kind"][i]]["label"], "rank": meta["kinds"][a["place_kind"][i]]["rank"],
               "town": text(a["place_town"][i]), "lon": a["place_lon"][i] / scale, "lat": a["place_lat"][i] / scale}
              for i in range(len(a["place_name"]))]
    return {"streets": streets, "places": places}


def places_filter_command(source: Path, target: Path) -> list[str]:
    """What a place index needs from a state extract: named things, addresses, and the outlines of
    named places mapped as multipolygons (osmium adds the ways and nodes they reference)."""
    relations = [f"r/{k}" for k in ("amenity", "shop", "tourism", "leisure", "aeroway", "building", "healthcare", "office")]
    return ["osmium", "tags-filter", str(source), "nw/name", "nw/brand", "nw/addr:housenumber", *relations,
            "--overwrite", "-o", str(target)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("extract", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--osm-at", help="when the OpenStreetMap data was current (ISO 8601)")
    args = ap.parse_args(argv)
    t0 = time.perf_counter()
    ix = build_index(args.extract)
    size = write_index(args.out, ix, built_at=dt.datetime.now(dt.UTC).isoformat(timespec="seconds"), osm_at=args.osm_at)
    print(f"{args.out}: {size / 1e6:.1f} MB, {json.dumps(counts(ix))} {json.dumps(ix.stats)} [{time.perf_counter() - t0:.0f} s]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
