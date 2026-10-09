/**
 * Turn-by-turn directions: a route's edges turned into the maneuvers a driver is told about
 * ("Turn left onto Oak Avenue", "Keep right toward Downtown", "At the roundabout, take the 2nd
 * exit").
 *
 * A maneuver is announced where the driver has a choice to get wrong. At each intersection the
 * route passes, the turn it takes is compared with the other ways out (not back the way it came,
 * and not a banned turn):
 *
 * - Nowhere else to go: nothing to say, however much the road bends. Except at the ends of a
 *   highway ramp, which are always announced (taking it, merging, and where it meets a street).
 * - A slip lane (a turn lane of its own, tagged like a ramp but between streets) is one turn,
 *   from the road before it onto the road after it.
 * - A turn of more than STRAIGHT_DEG: "Turn (slight / sharp) left / right", or a U-turn.
 * - Nearly straight, with another way out nearly straight too: a fork, "Keep left / right",
 *   unless the road being driven plainly carries on (it keeps its name and the other doesn't).
 *   A ramp or slip lane peeling off a road is never its fork: taking it is announced instead.
 * - Straight on through an intersection onto a street with another name: "Continue onto".
 *
 * Names come from the pack's road labels (pipeline/osm_graph.py, road_label). A pack without
 * them gives the same maneuvers, unnamed.
 */

import { compassBearing, wrap180 } from "./geo.ts";
import { GEOM_ROUNDABOUT, type RoadPack } from "./pack.ts";

export type StepType =
  | "depart" | "turn" | "fork" | "continue" | "ramp" | "exit" | "merge" | "roundabout" | "uturn" | "arrive";

export type Direction =
  | "straight" | "slight right" | "right" | "sharp right" | "uturn" | "sharp left" | "left" | "slight left";

export interface Step {
  type: StepType;
  /** How sharp a turn is; for a fork, ramp or exit, which side. */
  direction: Direction;
  /** Metres along the route where it happens. */
  atM: number;
  /** [lon, lat] of the intersection. */
  at: [number, number];
  /** The road it puts you on ("I-35E", "Oak Avenue"), or "" when the map doesn't name it. */
  road: string;
  /** Where a ramp or exit is signposted to ("Downtown"), or "". */
  toward: string;
  /** For a roundabout, which exit (1 is the first); 0 otherwise. */
  exit: number;
  /** The road you're on carries on through it ("to stay on Main Street"). */
  stay: boolean;
  /** Compass heading just after it. */
  heading: number;
}

/** A turn sharper than this (degrees) is a turn; within it, the road goes straight on. */
export const STRAIGHT_DEG = 35;
/** Another way out within this of straight makes a straight-on a fork. */
const FORK_DEG = 50;
/** A ramp meets its highway at a shallow angle: a merge. Sharper, it's a turn onto it. */
const MERGE_DEG = 60;
/** A road with no name of its own (a median crossing, a slip lane) takes the name of the next one this close. */
const NAME_LOOKAHEAD_M = 60;
/** A "Continue onto" this close before another maneuver is left out: that one says it. */
const CONTINUE_GAP_M = 40;
const HEADING_SAMPLE_M = 20;

const FREEWAYS = new Set(["motorway", "trunk"]);
const LINKS = new Set(["motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"]);
const FREEWAY_LINKS = new Set(["motorway_link", "trunk_link"]);

/** "I 35E;US 77" -> "I-35E/US-77", as signs write them. */
export function formatRef(ref: string): string {
  return ref.split(/\s*;\s*/).filter(Boolean).map((r) => r.replace(/^(I|US)\s+(?=\d)/, "$1-")).join("/");
}

/** A road label's parts: name, route number(s) and, for a ramp, where it's signposted to. */
export function parseLabel(label: string): { name: string; ref: string; toward: string } {
  const [name = "", ref = "", toward = ""] = label.split("\x1f");
  return { name, ref: formatRef(ref), toward: toward.split(/\s*;\s*/).filter(Boolean).join(", ") };
}

function direction(d: number): Direction {
  const a = Math.abs(d);
  const side = d > 0 ? "right" : "left";
  if (a <= 20) return "straight";
  if (a <= 60) return `slight ${side}`;
  if (a <= 140) return side;
  if (a <= 170) return `sharp ${side}`;
  return "uturn";
}

/** The maneuvers along a route (path edges, metres into the first and last), depart and arrive included. */
export function routeSteps(pack: RoadPack, edges: readonly number[], startOffset: number, endOffset: number): Step[] {
  const { edgeGeom, edgeSrc, edgeH0, edgeH1, edgeClass, geomLen, geomLabel, geomFlags, labels, twin, banned, hasBan,
    outPtr, nEdges, nodeX, nodeY, proj, meta } = pack;
  if (!edges.length) return [];
  const cls = (e: number) => meta.highway_classes[edgeClass[e]] ?? "";
  const label = (e: number) => parseLabel(labels[geomLabel[edgeGeom[e]]]);
  // Highways go by their number, streets by their name.
  const name = (e: number) => {
    const { name: n, ref } = label(e);
    return (FREEWAYS.has(cls(e)) || FREEWAY_LINKS.has(cls(e))) && ref ? ref : n || ref;
  };
  const freeway = (e: number) => FREEWAYS.has(cls(e));
  const link = (e: number) => LINKS.has(cls(e));
  const freewayLink = (e: number) => FREEWAY_LINKS.has(cls(e));
  const roundabout = (e: number) => (geomFlags[edgeGeom[e]] & GEOM_ROUNDABOUT) !== 0;
  const exits = (from: number, v: number) => {
    const out: number[] = [];
    for (let f = outPtr[v]; f < outPtr[v + 1]; f++) {
      if (f !== twin[from] && !(hasBan[from] && banned.has(from * nEdges + f))) out.push(f);
    }
    return out;
  };

  // Metres along the route where each edge starts.
  const startM = new Float64Array(edges.length + 1);
  edges.forEach((e, i) => {
    const a = i === 0 ? startOffset : 0;
    const b = i === edges.length - 1 ? endOffset : geomLen[edgeGeom[e]];
    startM[i + 1] = startM[i] + Math.max(0, b - a);
  });
  const lonLat = (x: number, y: number): [number, number] => [proj.lon(x), proj.lat(y)];
  const nodeAt = (v: number) => lonLat(nodeX[v], nodeY[v]);
  /** The first name on the route from edge i, looking a little way past unnamed stubs. */
  const nameFrom = (i: number) => {
    for (let j = i; j < edges.length && startM[j] - startM[i] <= NAME_LOOKAHEAD_M; j++) {
      const n = name(edges[j]);
      if (n) return n;
    }
    return "";
  };
  /** The highway a ramp starting at edge i leads to (its first non-ramp road), if the route takes it there. */
  const rampTo = (i: number) => {
    let j = i;
    while (j < edges.length && link(edges[j])) j++;
    return j < edges.length && freeway(edges[j]) ? name(edges[j]) : "";
  };

  const steps: Step[] = [];
  const add = (s: Omit<Step, "toward" | "exit" | "stay"> & Partial<Step>) =>
    steps.push({ toward: "", exit: 0, stay: false, ...s });

  const [x0, y0, h0] = along(pack, edges[0], startOffset);
  add({ type: "depart", direction: "straight", atM: 0, at: lonLat(x0, y0), road: nameFrom(0), heading: h0 });

  for (let i = 1; i < edges.length; i++) {
    const prev = edges[i - 1], e = edges[i], v = edgeSrc[e];
    const atM = startM[i], at = nodeAt(v);
    const d = wrap180(edgeH0[e] - edgeH1[prev]);
    const heading = edgeH0[e];

    if (roundabout(e) && !roundabout(prev)) {
      // Count the ways off the ring from here to where the route leaves it.
      let j = i + 1, exit = 0;
      for (; j < edges.length; j++) {
        if (exits(edges[j - 1], edgeSrc[edges[j]]).some((f) => !roundabout(f))) exit++;
        if (!roundabout(edges[j])) break;
      }
      const leaves = j < edges.length;
      add({ type: "roundabout", direction: direction(d), atM, at, road: leaves ? nameFrom(j) : "",
        exit: leaves ? exit : 0, heading: leaves ? edgeH0[edges[j]] : heading });
      i = Math.max(i, j); // the exit itself is part of this maneuver
      continue;
    }
    if (roundabout(prev)) continue; // a route that starts on the ring just drives off it

    const others = exits(prev, v).filter((f) => f !== e);
    const sameRoad = name(e) !== "" && name(e) === name(prev);
    const da = (f: number) => wrap180(edgeH0[f] - edgeH1[prev]);

    if (freeway(prev) && link(e)) {
      // Off the highway. Which side: against the highway carrying on, if it does.
      const ahead = others.filter(freeway).map(da);
      const side = ahead.length ? (d > Math.min(...ahead) ? "right" : "left") : d >= 0 ? "right" : "left";
      add({ type: "exit", direction: side, atM, at, road: name(e), toward: label(e).toward, heading });
      continue;
    }
    if (link(prev) && freeway(e) && Math.abs(d) <= MERGE_DEG) {
      add({ type: "merge", direction: direction(d), atM, at, road: name(e), heading });
      continue;
    }
    if (!link(prev) && !freeway(prev) && link(e)) {
      if (freewayLink(e) || rampTo(i)) {
        add({ type: "ramp", direction: direction(d), atM, at, road: rampTo(i), toward: label(e).toward, heading });
        continue;
      }
      // A slip lane: one turn onto the road at its end, said where it starts.
      let k = i;
      while (k < edges.length && link(edges[k])) k++;
      if (k < edges.length) {
        const turn = wrap180(edgeH0[edges[k]] - edgeH1[prev]);
        const road = nameFrom(k);
        if (Math.abs(turn) > STRAIGHT_DEG) {
          add({ type: "turn", direction: direction(turn), atM, at, road, stay: road !== "" && road === name(prev), heading });
        } else {
          add({ type: "fork", direction: d < 0 ? "slight left" : "slight right", atM, at, road, heading });
        }
        i = k; // its end is part of this turn
        continue;
      }
    }
    if (e === twin[prev]) { // only ever at a dead end
      add({ type: "uturn", direction: "uturn", atM, at, road: "", heading });
      continue;
    }
    // The end of a highway ramp is always worth a word; elsewhere, only a choice is.
    const rampEnd = freewayLink(prev) && !link(e);
    if (!others.length && !rampEnd) continue;

    if (Math.abs(d) > STRAIGHT_DEG) {
      add({ type: "turn", direction: direction(d), atM, at, road: nameFrom(i), stay: sameRoad, heading });
    } else {
      const rivals = others.filter((f) => Math.abs(da(f)) <= FORK_DEG && link(f) === link(e));
      const carriesOn = sameRoad && rivals.every((f) => name(f) !== name(e));
      if (rivals.length && !carriesOn) {
        const angles = rivals.map(da);
        const dir: Direction = d < Math.min(...angles) ? "slight left" : d > Math.max(...angles) ? "slight right" : "straight";
        add({ type: "fork", direction: dir, atM, at, road: nameFrom(i), toward: link(e) ? label(e).toward : "",
          stay: sameRoad, heading });
      } else if (rampEnd || (!sameRoad && name(e) && name(prev) && !(freeway(prev) && freeway(e)))) {
        add({ type: "continue", direction: "straight", atM, at, road: nameFrom(i), heading });
      }
    }
  }

  const last = edges[edges.length - 1];
  const [x1, y1, h1] = along(pack, last, endOffset);
  add({ type: "arrive", direction: "straight", atM: startM[edges.length], at: lonLat(x1, y1), road: "", heading: h1 });

  // A "Continue onto" right before another maneuver is noise: the next one names the road.
  return steps.filter((s, k) => s.type !== "continue" || steps[k + 1].atM - s.atM >= CONTINUE_GAP_M);
}

/**
 * The point `s` metres into edge e (in its direction of travel) and the heading there, looking
 * a short way ahead (behind, at the very end).
 */
function along(pack: RoadPack, e: number, s: number): [number, number, number] {
  const { edgeGeom, edgeRev, geomLen } = pack;
  const g = edgeGeom[e], L = geomLen[g], rev = edgeRev[e] === 1;
  const point = (t: number) => geomPoint(pack, g, rev ? L - t : t);
  const [x, y] = point(s);
  const [ax, ay] = point(Math.max(0, Math.min(s, L - HEADING_SAMPLE_M)));
  const [bx, by] = point(Math.min(L, Math.max(s, 0) + HEADING_SAMPLE_M));
  const h = Math.hypot(bx - ax, by - ay) > 0.01 ? compassBearing(bx - ax, by - ay) : pack.edgeH0[e];
  return [x, y, h];
}

/** The projected point `s` metres from geometry g's first vertex. */
function geomPoint(pack: RoadPack, g: number, s: number): [number, number] {
  const { geomPtr, vx, vy, vs } = pack;
  let k = geomPtr[g];
  while (k + 2 < geomPtr[g + 1] && vs[k + 1] < s) k++;
  const seg = vs[k + 1] - vs[k];
  const t = seg > 0 ? Math.min(1, Math.max(0, (s - vs[k]) / seg)) : 0;
  return [vx[k] + t * (vx[k + 1] - vx[k]), vy[k] + t * (vy[k + 1] - vy[k])];
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/**
 * What a step says, as a sentence: "Turn left onto Oak Avenue". `destination` names the end of
 * the trip for the arrival ("Arrive at Bean There").
 */
export function describeStep(step: Step, destination = ""): string {
  const onto = step.road ? ` onto ${step.road}` : "";
  const toward = step.toward ? ` toward ${step.toward}` : "";
  const side = step.direction.includes("left") ? "left" : "right";
  switch (step.type) {
    case "depart":
      return `Head ${COMPASS[Math.round(step.heading / 45) % 8]}${step.road ? ` on ${step.road}` : ""}`;
    case "turn":
      return step.stay
        ? `Turn ${step.direction} to stay on ${step.road}`
        : `Turn ${step.direction}${onto}`;
    case "fork": {
      const which = step.direction === "straight" ? "Keep straight" : `Keep ${side}`;
      return step.stay ? `${which} to stay on ${step.road}` : `${which}${step.road ? onto : toward}`;
    }
    case "continue":
      return step.road ? `Continue onto ${step.road}` : "Continue straight";
    case "ramp": {
      const where = step.direction === "straight" ? "" : ` on the ${side}`;
      return `Take the ramp${where}${step.road ? ` to ${step.road}` : ""}${toward}`;
    }
    case "exit":
      return `Take the exit on the ${side}${step.road && !step.toward ? onto : toward}`;
    case "merge":
      return `Merge${onto}`;
    case "roundabout":
      return step.exit
        ? `At the roundabout, take the ${ORDINALS[step.exit - 1] ?? `${step.exit}th`} exit${onto}`
        : "Enter the roundabout";
    case "uturn":
      return "Make a U-turn";
    case "arrive":
      return destination ? `Arrive at ${destination}` : "Arrive at your destination";
  }
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
