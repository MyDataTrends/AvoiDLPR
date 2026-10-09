// Turn-by-turn directions on screen and out loud: the next maneuver in a card over the map while
// driving or previewing, the route's steps in the panel, and spoken prompts while driving. The
// steps themselves come from the router (packages/router/src/guidance.ts).
//
// Speech uses only voices the browser says run on the device (`localService`): some browsers also
// offer voices that send the text to a server, and the text names the streets you're about to
// drive. With no on-device voice, the app stays quiet and says so in the menu.
import { describeStep, type Step } from "@flockwatch/router";

import { distance, spokenDistance } from "./format.ts";

type Icon = "straight" | "slight-right" | "right" | "sharp-right" | "slight-left" | "left" | "sharp-left" | "uturn"
  | "roundabout" | "arrive";

// 24-unit arrows, drawn with a round stroke like the app's other icons.
const ICONS: Record<Icon, string> = {
  "straight": "M12 21V4M6 10l6-6 6 6",
  "right": "M8 21v-8a3 3 0 013-3h9M15 5l5 5-5 5",
  "left": "M16 21v-8a3 3 0 00-3-3H4M9 5l-5 5 5 5",
  "slight-right": "M9 21v-6c0-2 1-3.5 2.5-5L18 4M12 4h6v6",
  "slight-left": "M15 21v-6c0-2-1-3.5-2.5-5L6 4M12 4H6v6",
  "sharp-right": "M7 21V8a3 3 0 015.1-2.1L19 13M19 7v6h-6",
  "sharp-left": "M17 21V8a3 3 0 00-5.1-2.1L5 13M5 7v6h6",
  "uturn": "M16 21V9a4.5 4.5 0 00-9 0v9M3.5 14.5L7 18l3.5-3.5",
  "roundabout": "M12 21v-6.5M12 14.5a4.5 4.5 0 114.2-6M17.5 3.5l-1.3 5-5-1.2",
  "arrive": "M12 21s-6-5.5-6-10a6 6 0 0112 0c0 4.5-6 10-6 10zM12 9.2v3.6",
};

function iconFor(step: Step): Icon {
  if (step.type === "arrive") return "arrive";
  if (step.type === "roundabout") return "roundabout";
  if (step.type === "uturn" || step.direction === "uturn") return "uturn";
  // A fork, an exit or a ramp says which side; its arrow bears off that way.
  const side = step.direction.includes("left") ? "left" : step.direction.includes("right") ? "right" : "";
  if (["fork", "exit", "ramp", "merge"].includes(step.type)) return side ? `slight-${side}` : "straight";
  return step.direction.replace(" ", "-") as Icon;
}

export function maneuverIcon(step: Step): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[iconFor(step)]);
  svg.append(path);
  return svg;
}

/** "Arrive at Bean There": a destination's name, unless it's only "Near …" a spot. */
export function stepText(step: Step, destination?: string): string {
  return describeStep(step, destination && !/^near /i.test(destination) ? destination : "");
}

/** On screen, a route number doesn't break at its hyphen ("I-" on one line, "35E" on the next). */
function unbroken(text: string): string {
  return text.replace(/\b([A-Z]{1,3})-(?=\d)/g, "$1\u2011");
}

/** The next maneuver at `distM` metres along the route (never the departure), and the one after it. */
export function upcoming(steps: readonly Step[], distM: number): [Step | null, Step | null] {
  const k = steps.findIndex((s) => s.type !== "depart" && s.atM > distM);
  return k < 0 ? [null, null] : [steps[k], steps[k + 1] ?? null];
}

/** A maneuver this soon after the next one gets a "Then" under it, on screen and out loud. */
const THEN_M = 200;

/** The card over the map: the next maneuver, how far to it, and what follows right after. */
export class GuideCard {
  private shown: Step | null = null;

  constructor(private readonly el: HTMLElement) {}

  show(steps: readonly Step[], distM: number, destination?: string): void {
    const [next, after] = upcoming(steps, distM);
    this.el.hidden = !next;
    if (!next) return;
    this.el.querySelector(".guide-dist")!.textContent = distance(Math.max(0, next.atM - distM));
    if (next !== this.shown) {
      this.shown = next;
      this.el.querySelector(".guide-icon")!.replaceChildren(maneuverIcon(next));
      this.el.querySelector(".guide-what")!.textContent = unbroken(stepText(next, destination));
      const then = this.el.querySelector<HTMLElement>(".guide-then")!;
      const soon = after && after.atM - next.atM <= THEN_M ? after : null;
      then.hidden = !soon;
      if (soon) then.replaceChildren("Then ", maneuverIcon(soon), ` ${unbroken(stepText(soon, destination))}`);
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.shown = null;
  }
}

/** The selected route's steps as a list: each with its arrow, what to do, and how far to drive after. */
export function stepItems(steps: readonly Step[], destination: string | undefined, onPick: (s: Step) => void): HTMLLIElement[] {
  return steps.map((s, k) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "step-icon";
    icon.append(maneuverIcon(s));
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = unbroken(stepText(s, destination));
    button.append(icon, what);
    const next = steps[k + 1];
    if (next) {
      const how = document.createElement("span");
      how.className = "how";
      how.textContent = distance(next.atM - s.atM);
      button.append(how);
    }
    button.addEventListener("click", () => onPick(s));
    li.append(button);
    return li;
  });
}

/** Spoken directions, in an on-device voice (see the top of this file). */
export class Voice {
  private voice: SpeechSynthesisVoice | null = null;
  private readonly synth = "speechSynthesis" in window ? window.speechSynthesis : null;

  /** `onChange` runs when the browser's voices arrive or change (not for the ones it has now). */
  constructor(onChange: () => void) {
    if (!this.synth) return;
    this.voice = pickVoice(this.synth.getVoices());
    this.synth.addEventListener?.("voiceschanged", () => { // voices often arrive after the page loads
      this.voice = pickVoice(this.synth!.getVoices());
      onChange();
    });
  }

  /** Whether this browser has a voice that speaks English on the device. */
  get available(): boolean {
    return this.voice !== null;
  }

  /** Say this now, cutting off anything older. Called first in a tap, it also wins the browser's leave to speak. */
  say(text: string): void {
    if (!this.synth || !this.voice) return;
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice;
    u.lang = this.voice.lang;
    this.synth.speak(u);
  }

  stop(): void {
    this.synth?.cancel();
  }
}

/** An English voice that runs on the device: the device's own language first, then its default. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const local = voices.filter((v) => v.localService && /^en\b/i.test(v.lang.replace("_", "-")));
  const lang = navigator.language.toLowerCase();
  const rank = (v: SpeechSynthesisVoice) =>
    (v.lang.replace("_", "-").toLowerCase() === lang ? 2 : 0) + (v.default ? 1 : 0);
  return local.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/**
 * When to speak while driving. Each maneuver gets an early word ("In a quarter mile, turn left
 * onto Oak Avenue"), about half a minute out at the current speed, and another as it comes up
 * ("Turn left onto Oak Avenue"), with what follows if that's right after.
 */
export class Prompter {
  private early = new Set<Step>();
  private now = new Set<Step>();

  constructor(private readonly speak: (text: string) => void) {}

  reset(): void {
    this.early.clear();
    this.now.clear();
  }

  /** A new fix: speak whatever is due. `speedMps` 0 means unknown. */
  update(steps: readonly Step[], distM: number, speedMps: number, destination?: string): void {
    const [next, after] = upcoming(steps, distM);
    if (!next) return;
    const v = speedMps > 1 ? speedMps : 12;
    const nearM = Math.min(250, Math.max(40, v * 7));
    const farM = Math.min(1600, Math.max(250, v * 30));
    const left = next.atM - distM;
    const text = stepText(next, destination);
    if (left <= nearM) {
      if (this.now.has(next)) return;
      this.now.add(next);
      this.early.add(next);
      const soon = after && after.atM - next.atM <= THEN_M ? `, then ${lowerFirst(stepText(after, destination))}` : "";
      if (soon) this.early.add(after!); // mentioned now, so no "In …" for it
      this.speak(`${text}${soon}`);
    } else if (left <= farM && !this.early.has(next)) {
      this.early.add(next);
      // A maneuver that comes up right after the last one was already mentioned with it.
      if (left > nearM * 1.5) this.speak(`In ${spokenDistance(left)}, ${lowerFirst(text)}`);
    }
  }
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
