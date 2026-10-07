// "Your ride": the little vehicle that stands for you on the map, at your location and while you
// drive (where it turns with your heading). Each is a top-down sprite facing up (north), with
// headlight eyes over a windshield grin. Picked in the menu and remembered on this device.

export type Ride = "hatchback" | "pickup" | "van" | "scooter";

export const RIDES: readonly { id: Ride; name: string }[] = [
  { id: "hatchback", name: "Hatchback" },
  { id: "pickup", name: "Pickup" },
  { id: "van", name: "Van" },
  { id: "scooter", name: "Scooter" },
];

const INK = "#1f2328";
const SHADOW = `<ellipse cx="25.5" cy="27" rx="14" ry="19.5" fill="#000" opacity=".2"/>`;

/** Two wheels a side, at the given heights. */
const wheels = (front: number, back: number, left = 9.6, right = 33) => `<g fill="${INK}">${
  [front, back].map((y) => `<rect x="${left}" y="${y}" width="5.4" height="9" rx="2.4"/><rect x="${right}" y="${y}" width="5.4" height="9" rx="2.4"/>`).join("")
}</g>`;

/** Headlight eyes, looking ahead. */
const face = (eyesY: number, left = 18, right = 30, r = 2.7) => `<g stroke="${INK}" stroke-width="1.4">
<circle cx="${left}" cy="${eyesY}" r="${r}" fill="#fff"/><circle cx="${right}" cy="${eyesY}" r="${r}" fill="#fff"/></g>
<circle cx="${left}" cy="${eyesY - 0.8}" r="${r * 0.43}" fill="${INK}"/><circle cx="${right}" cy="${eyesY - 0.8}" r="${r * 0.43}" fill="${INK}"/>`;

const SPRITES: Record<Ride, string> = {
  hatchback: `${SHADOW}${wheels(10.5, 28.5)}
<g stroke="${INK}" stroke-width="1.9" stroke-linejoin="round">
<rect x="12" y="4.5" width="24" height="38.5" rx="11" fill="#4dabf7"/>
<path d="M15.6 18c5.4-3 11.4-3 16.8 0l-1.7 5.4c-4.4-1.8-9-1.8-13.4 0z" fill="#e7f5ff"/>
<rect x="16.6" y="23.6" width="14.8" height="11.4" rx="5" fill="#a5d8ff"/>
<path d="M17.4 38.6c4.4 1.5 8.8 1.5 13.2 0" fill="none" stroke-linecap="round"/></g>
${face(10.6)}`,

  pickup: `${SHADOW}${wheels(9.5, 31)}
<g stroke="${INK}" stroke-width="1.9" stroke-linejoin="round">
<rect x="12" y="3.5" width="24" height="41" rx="9" fill="#ffc94d"/>
<path d="M15.6 15.6c5.4-3 11.4-3 16.8 0l-1.6 5c-4.4-1.8-9-1.8-13.6 0z" fill="#fff9db"/>
<rect x="16.6" y="20.8" width="14.8" height="7.4" rx="3.4" fill="#ffe08a"/>
<rect x="15" y="30.6" width="18" height="11" rx="2.6" fill="#e8a317"/></g>
<path d="M21 32.6v7M27 32.6v7" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>
${face(9.4)}`,

  van: `${SHADOW}${wheels(8.8, 31.5, 9.1, 33.5)}
<g stroke="${INK}" stroke-width="1.9" stroke-linejoin="round">
<rect x="11.5" y="3.5" width="25" height="41" rx="8.5" fill="#b197fc"/>
<path d="M15 14.6c5.8-2.6 12.2-2.6 18 0l-1.3 4.6c-5-1.6-10.4-1.6-15.4 0z" fill="#f3f0ff"/>
<rect x="15.5" y="20.4" width="17" height="20.2" rx="4" fill="#d0bfff"/></g>
<path d="M19.6 23.6v13.8M28.4 23.6v13.8" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" opacity=".45"/>
${face(9)}`,

  scooter: `<ellipse cx="25" cy="27" rx="9.5" ry="19.5" fill="#000" opacity=".2"/>
<g fill="${INK}"><rect x="21.5" y="2.5" width="5" height="7" rx="2.5"/><rect x="21.5" y="38.5" width="5" height="7.5" rx="2.5"/></g>
<g stroke="${INK}" stroke-width="1.9" stroke-linejoin="round">
<rect x="17.5" y="6.5" width="13" height="34.5" rx="6.5" fill="#63e6be"/>
<rect x="12.5" y="15.6" width="23" height="2.4" rx="1.2" fill="${INK}"/>
<circle cx="24" cy="26" r="7.2" fill="#ff8c42"/>
<path d="M18.8 23.6q5.2-4.2 10.4 0" fill="none" stroke-linecap="round"/></g>
${face(11, 21.3, 26.7, 2.1)}`,
};

/** The ride's sprite as an SVG document (trusted markup: built from the constants above). */
export function rideSvg(ride: Ride, size = 44): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true">${SPRITES[ride]}</svg>`;
}

const KEY = "avoidlpr.ride";

export function savedRide(): Ride {
  try {
    const r = localStorage.getItem(KEY);
    if (RIDES.some((x) => x.id === r)) return r as Ride;
  } catch {
    /* storage blocked: the default ride */
  }
  return "hatchback";
}

export function saveRide(ride: Ride): void {
  try {
    localStorage.setItem(KEY, ride);
  } catch {
    /* storage blocked: it lasts until the page closes */
  }
}
