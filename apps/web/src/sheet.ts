// The planner panel as a bottom sheet on phones: drag the handle (or press Up / Down on it)
// between three heights. On wide screens the panel is a sidebar and none of this applies.

export type SheetState = "peek" | "half" | "full";
const ORDER: SheetState[] = ["peek", "half", "full"];
/** Pixels per millisecond of finger speed that carries a drag into the next snap point. */
const FLING_MS = 180;

export class Sheet {
  state: SheetState = "half";
  private readonly panel: HTMLElement;
  private readonly head: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly query = window.matchMedia("(max-width: 760px)");
  private readonly onSettle: (heightPx: number) => void;
  private drag: { startY: number; startH: number; moved: boolean; lastY: number; lastT: number; v: number } | null = null;

  /** `onSettle` fires with the sheet's height once it stops moving (0 when it isn't a sheet). */
  constructor(panel: HTMLElement, head: HTMLElement, handle: HTMLElement, onSettle: (heightPx: number) => void) {
    this.panel = panel;
    this.head = head;
    this.handle = handle;
    this.onSettle = onSettle;
    head.addEventListener("pointerdown", (e) => this.down(e));
    head.addEventListener("pointermove", (e) => this.move(e));
    head.addEventListener("pointerup", (e) => this.up(e));
    head.addEventListener("pointercancel", (e) => this.up(e));
    // Enter / Space on the focused handle arrive as clicks with detail 0; real taps are
    // already handled on pointer-up.
    handle.addEventListener("click", (e) => {
      if (e.detail === 0 && this.isSheet) this.set(this.state === "peek" ? "half" : "peek");
    });
    handle.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      this.set(ORDER[Math.min(2, Math.max(0, ORDER.indexOf(this.state) + step))]);
    });
    this.query.addEventListener("change", () => this.set(this.state, false));
    window.addEventListener("resize", () => this.set(this.state, false));
    this.set(this.state, false);
  }

  get isSheet(): boolean {
    return this.query.matches;
  }

  /** Current snap heights in pixels. */
  heights(): Record<SheetState, number> {
    const bottom = parseFloat(getComputedStyle(this.panel).paddingBottom) || 0;
    return {
      peek: Math.round(this.head.offsetHeight + bottom),
      half: Math.round(window.innerHeight * 0.46),
      full: Math.round(window.innerHeight * 0.9),
    };
  }

  set(state: SheetState, animate = true): void {
    this.state = state;
    this.panel.dataset.state = state;
    document.documentElement.dataset.sheet = this.isSheet ? state : "";
    this.handle.setAttribute("aria-expanded", String(state !== "peek"));
    this.handle.setAttribute("aria-label", `Resize panel, ${state === "peek" ? "collapsed" : state === "half" ? "half open" : "fully open"}`);
    this.panel.classList.toggle("animate", animate);
    const px = this.isSheet ? this.heights()[state] : 0;
    this.apply(px);
    this.onSettle(px);
  }

  private apply(px: number): void {
    document.documentElement.style.setProperty("--sheet-h", `${px}px`);
  }

  private height(): number {
    return this.panel.getBoundingClientRect().height;
  }

  private down(e: PointerEvent): void {
    // Buttons in the head (Start) are buttons, not drag handles.
    if (!this.isSheet || (e.target as Element).closest("button:not(.handle)")) return;
    this.head.setPointerCapture(e.pointerId);
    this.drag = { startY: e.clientY, startH: this.height(), moved: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) > 6) {
      d.moved = true;
      this.panel.classList.remove("animate");
      this.panel.classList.add("dragging");
    }
    if (!d.moved) return;
    const h = this.heights();
    this.apply(Math.min(h.full, Math.max(h.peek, d.startH + d.startY - e.clientY)));
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (d.lastY - e.clientY) / dt; // positive = moving up
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  }

  private up(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.panel.classList.remove("dragging");
    if (!d.moved) {
      // A tap on the head: open a collapsed sheet, collapse an open one.
      this.set(this.state === "peek" ? "half" : "peek");
      return;
    }
    const heights = this.heights();
    const projected = this.height() + d.v * FLING_MS;
    const nearest = ORDER.reduce((best, s) => (Math.abs(heights[s] - projected) < Math.abs(heights[best] - projected) ? s : best));
    this.head.releasePointerCapture(e.pointerId);
    this.set(nearest);
  }
}
