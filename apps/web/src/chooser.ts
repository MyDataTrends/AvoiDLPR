// "Where do you drive?": the list of covered areas, searchable, grouped by state, with a button
// that picks the area you're in. The app routes one area at a time (its road map lives on the
// phone), so this is how you get to yours. A location fix is used here and forgotten: only the
// area's id is passed on.
import { areaMatches, kmTo, type Manifest, type RegionEntry, regionsContaining } from "./data.ts";
import { LocateError, locate } from "./location.ts";

export type PickHow = "list" | "location";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const NEAREST_SHOWN = 3;

export class Chooser {
  private readonly dialog = $<HTMLDialogElement>("chooser");
  private readonly list = $("chooserList");
  private readonly search = $<HTMLInputElement>("chooserSearch");
  private readonly items: { region: RegionEntry; li: HTMLLIElement }[] = [];
  private required = false;

  constructor(private readonly manifest: Manifest, private readonly onPick: (r: RegionEntry, how: PickHow) => void) {
    const groups = new Map<string, RegionEntry[]>();
    for (const r of [...manifest.regions].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) {
      groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    }
    for (const [group, regions] of groups) {
      const section = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = group;
      const ul = document.createElement("ul");
      for (const r of regions) {
        const li = document.createElement("li");
        li.append(this.button(r));
        ul.append(li);
        this.items.push({ region: r, li });
      }
      section.append(h, ul);
      this.list.append(section);
    }
    $("chooserLede").textContent = `AvoiDLPR covers ${manifest.regions.length} US metro areas. It works on one at a `
      + "time: the area's roads and cameras download to your device, and every route is worked out there.";
    this.search.addEventListener("input", () => this.filter());
    $("chooserLocate").addEventListener("click", () => void this.useLocation());
    $("chooserClose").addEventListener("click", () => this.close());
    // Escape closes the dialog unless there's no area to go back to.
    this.dialog.addEventListener("cancel", (e) => {
      if (this.required) e.preventDefault();
    });
  }

  /** `required`: there's no area loaded yet, so the dialog can't be dismissed. */
  open({ required = false, current }: { required?: boolean; current?: string } = {}): void {
    this.required = required;
    $("chooserClose").hidden = required;
    document.documentElement.dataset.chooser = required ? "required" : "open";
    for (const { region, li } of this.items) {
      li.querySelector("button")!.setAttribute("aria-current", String(region.id === current));
    }
    this.setNotice(null);
    $("chooserNearby").replaceChildren();
    this.search.value = "";
    this.filter();
    if (!this.dialog.open) this.dialog.showModal();
    // A phone's keyboard would cover the list: only desktops get the search box focused.
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) this.search.focus();
  }

  /** `force`: an area's been picked, so even a required chooser can go. */
  close(force = false): void {
    if (this.required && !force) return;
    this.required = false;
    this.dialog.close();
    delete document.documentElement.dataset.chooser;
  }

  private button(r: RegionEntry): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "area";
    const name = document.createElement("span");
    name.className = "area-name";
    name.textContent = r.name;
    const meta = document.createElement("span");
    meta.className = "area-meta";
    meta.textContent = [r.states.join("–"), `${Math.max(1, Math.round(r.pack.bytes / 1e6))} MB`].filter(Boolean).join(" · ");
    b.append(name, meta);
    b.addEventListener("click", () => this.onPick(r, "list"));
    return b;
  }

  private filter(): void {
    const q = this.search.value.trim();
    for (const { li, region } of this.items) li.hidden = Boolean(q) && !areaMatches(region, q);
    for (const section of this.list.querySelectorAll("section")) {
      section.hidden = [...section.querySelectorAll("li")].every((li) => li.hidden);
    }
    $("chooserEmpty").hidden = this.items.some(({ li }) => !li.hidden);
  }

  private setNotice(text: string | null): void {
    $("chooserNotice").hidden = !text;
    $("chooserNotice").textContent = text ?? "";
  }

  private async useLocation(): Promise<void> {
    const btn = $<HTMLButtonElement>("chooserLocate");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    this.setNotice("Finding your location…");
    try {
      const fix = await locate();
      const inside = regionsContaining(this.manifest, [fix.lon, fix.lat]);
      if (inside.length) {
        this.setNotice(null);
        this.onPick(inside[0], "location");
        return;
      }
      const nearest = [...this.manifest.regions]
        .map((r) => ({ r, km: kmTo(r, fix.lon, fix.lat) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, NEAREST_SHOWN);
      this.setNotice("AvoiDLPR doesn't cover where you are yet. These are the closest areas it does:");
      $("chooserNearby").replaceChildren(...nearest.map(({ r, km }) => {
        const b = this.button(r);
        b.querySelector(".area-meta")!.textContent = [r.states.join("–"), `${Math.round(km)} km away`].filter(Boolean).join(" · ");
        return b;
      }));
    } catch (err) {
      const reason = err instanceof LocateError ? err.reason : "unavailable";
      this.setNotice(reason === "denied"
        ? "Location access is blocked for this site. Pick your area from the list instead."
        : reason === "insecure" || reason === "unsupported"
          ? "This browser can't share your location here. Pick your area from the list."
          : "Couldn't get your location. Pick your area from the list.");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }
}
