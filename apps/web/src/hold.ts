// Holding a finger (or the mouse button) still on the map: the touch screen's right-click. A tap
// on the map does nothing much any more, so a finger that lands while you pan can't move your
// destination; holding a spot opens its menu (main.ts). A right-click does the same.

import { type LngLat, type Map as MapLibreMap, Point } from "maplibre-gl";

/** How long a press has to stay put to count, and how far it may wander (screen pixels). */
export const HOLD_MS = 500;
export const HOLD_SLOP_PX = 8;

export interface Holds {
  /** Whether the press that just ended was a hold: the click it ends with isn't a tap. */
  consumeClick(): boolean;
}

/** Call `then` with the spot (and its screen point) whenever the map is held, or right-clicked. */
export function onHold(map: MapLibreMap, then: (at: LngLat, point: Point) => void): Holds {
  const el = map.getCanvasContainer();
  let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The press going on (or just ended) was a hold. Every press starts afresh. */
  let held = false;

  const cancel = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  const fire = (clientX: number, clientY: number) => {
    // A long press can also bring the browser's own context menu: one hold, one menu.
    if (held) return;
    held = true;
    const box = el.getBoundingClientRect();
    const point = new Point(clientX - box.left, clientY - box.top);
    then(map.unproject(point), point);
  };

  el.addEventListener("pointerdown", (e) => {
    held = false;
    // A second finger is a pinch, and other mouse buttons have their own jobs.
    if (press || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) {
      cancel();
      return;
    }
    const { clientX: x, clientY: y } = e;
    press = { id: e.pointerId, x, y, timer: setTimeout(() => {
      press = null;
      fire(x, y);
    }, HOLD_MS) };
  });
  el.addEventListener("pointermove", (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > HOLD_SLOP_PX) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) el.addEventListener(type, cancel);
  // A pan or a pinch ends it; the map moving by itself (following you, framing a route) doesn't.
  map.on("movestart", (e) => {
    if (e.originalEvent) cancel();
  });
  map.on("contextmenu", (e) => {
    e.preventDefault();
    fire(e.originalEvent.clientX, e.originalEvent.clientY);
  });

  return {
    consumeClick() {
      const was = held;
      held = false;
      return was;
    },
  };
}
