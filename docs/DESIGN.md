# AvoiDLPR's design

How the app looks and why, for anyone changing its screens. The tokens live at the top of
[`apps/web/src/style.css`](../apps/web/src/style.css), the map's colours in
[`apps/web/src/map.ts`](../apps/web/src/map.ts) (`PALETTES`), and the rides in
[`apps/web/src/personas.ts`](../apps/web/src/personas.ts).

## Principles

- **Map first, like any map app.** With nothing planned, the screen is the map, a **Where to?**
  box and a row of quick searches. Everything else waits until it's useful: the directions panel
  opens with a destination, and settings, the map key and the data's dates live in the menu.
- **One thing to do next.** Each view has one primary (filled) button: **Start** in a trip. Other
  actions are outlined (**Preview**) or plain text (**Clear**).
- **Red means cameras.** Red marks camera zones, the cameras a route passes and the alert banner,
  and nothing else. The interactive accent is blue, and "no cameras" is green.
- **Say it plainly.** "26 min · Fastest · 6 camera zones", not a table. Time comes first, as in
  every routing app, then what it costs in cameras.

## Where the look comes from

The tokens started from the Airbnb entry in
[awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT), a write-up of that
site's public CSS: white canvas, near-black ink (#222222), soft radii, pill-shaped search, one
light shadow tier, modest type weights. Two things changed:

- **Blue instead of coral.** Its brand accent (#ff385c) would read as "camera" here, so the accent
  is #2563eb (#6b9bff in the dark).
- **The system font.** Its typeface isn't free to use; the stack is `-apple-system`, Segoe UI,
  Roboto and friends, so text looks native on every phone.

The dark palette is our own.

## Tokens

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--canvas` | #ffffff | #1f2023 | The panel, menu, buttons and pill |
| `--surface-soft` / `--surface-strong` | #f7f7f7 / #f2f2f2 | #26272b / #2e2f34 | Result icons, hovers, the segmented control |
| `--ink` | #222222 | #f2f2f2 | Headings, times, field text |
| `--body` / `--muted` | #3f3f3f / #6a6a6a | #d4d4d6 / #a1a1a6 | Body text / labels, distances, notes |
| `--hairline` | #dddddd | #3a3b40 | Card and field borders, dividers |
| `--accent` | #2563eb | #6b9bff | Start, links, focus, the selected route |
| `--on-accent` | #ffffff | #0b1220 | Text on the accent |
| `--zone` / `--zone-soft` | #e03131 / #fff0f0 | #ff6b6b / #3a1f22 | Camera-zone counts (text on a soft badge) |
| `--alert` | #e03131 | #c92a2a | The zone banner and Stop, both with white text |
| `--ahead` | #f59f00 | #fab005 | The "camera ahead" banner (dark text) |
| `--ok` / `--ok-soft` | #2f9e44 / #ebfbee | #51cf66 / #1d3324 | "No camera zones" |

Text on a coloured surface keeps at least 4.5:1 contrast. That's why `--alert` exists: the dark
map needs a lighter red (#ff6b6b) to show, but white text on it is only 2.8:1, so banners and
Stop take a deeper red (5.5:1).

| | |
|---|---|
| Radii | 8 px (small), 14 px (fields, cards, the desktop panel), 20 px (sheets, the menu), full (pill, chips, round buttons) |
| Shadow | One tier, for things floating over the map: `rgb(0 0 0/.02) 0 0 0 1px, rgb(0 0 0/.04) 0 2px 6px, rgb(0 0 0/.1) 0 4px 8px` (darker in the dark) |
| Type | 22 px dialog titles, 20 px route times and the Directions heading, 16 px fields, buttons and body (16 px also stops iOS zooming on focus), 14 px text buttons, badges and notes, 13 px result details, 11 px the *Recommended* badge; weights mostly 500 and 600 |
| Touch | Controls at least 48 px (`--tap`); the map attribution's button 36 px |

### The map

| | Light | Dark |
|---|---|---|
| Basemap | Protomaps `light` flavour | Protomaps `dark` flavour, with its own icons (`sprite_dark` in the manifest) |
| Selected route / other routes | #2563eb / #8d96a0 | #6b9bff / #6c7480 |
| Camera / on the route / avoided | #495057 / #e03131 / #2f9e44 | #adb5bd / #ff6b6b / #51cf66 |
| Camera zone fill | #e03131 | #ff6b6b |

## Layout

The root element carries the state that drives the layout: `data-mode` (`idle` with nothing
planned, `trip` with a destination), `data-searching` (a search field has focus),
`data-following` (`drive` for a preview, `nav` while navigating) and `data-theme`.

| | Phone (up to 760 px) | Wider |
|---|---|---|
| Nothing planned | The **Where to?** pill and quick searches at the top, the menu button beside them, locate at the bottom right | The same, at the top left |
| Searching | Full-screen search: back button, the From and To fields, results sized to what the keyboard leaves | Results open under the fields, in the card |
| A trip | A bottom sheet (peek, half, full) with Start in its header, so it's in reach at any height | A 400 px card at the top left, over the map |
| Previewing or driving | The sheet drops to its peek, the menu button goes, a banner at the top, the map follows your ride | The banner at the top, the map follows |

The map's own padding tracks whatever covers it (the sheet, the card, the pill), so fitting a
route or following your ride always targets the part of the map you can see.

## Components

- **Where to?** The To field itself, styled as a pill with a search icon. Tapping it opens the
  search, with the From field above it.
- **Quick searches.** Chips under the pill: *Try a sample trip*, Gas, Coffee, Groceries, Food. A
  chip opens the search with its words typed in.
- **Route option.** A card: the time large, its label beside it (Fastest, Balanced, Fewer cameras,
  Fewest cameras) with a *Recommended* badge, then the extra time and distance, and the
  camera-zone count on a soft red badge (green for none). The selected card gets a 2 px ink border.
- **Banner.** A pill at the top of the map while previewing or driving: red with white text in a
  camera zone, amber with dark text for a camera ahead, the canvas colour otherwise.
- **Menu.** A dialog from the round button at the top right, a bottom sheet on phones: your area,
  your ride, Appearance (Auto, Light, Dark), camera alerts (sound, which zone model), install
  help, the map key and where the data comes from.

## Your ride

You're drawn on the map as a small cartoon vehicle: Hatchback (blue), Pickup (yellow), Van
(purple) or Scooter (mint, with an orange helmet). Each is a top-down SVG on a 48-unit grid, facing
north, with a #1f2328 outline (1.9 units), dark wheels, a soft shadow and two headlight eyes, so it
stays readable at 44 px on a busy street map. It turns with your heading while you drive, pulses
softly while it's your live location, and gets a faint light outline in the dark. The ride you
pick in the menu is remembered on the device. To add one, add a sprite to `SPRITES` and an entry
to `RIDES`; keep the outline, the eyes and a body colour that isn't red.

## Dark mode

Appearance in the menu is **Auto** (follow the device), **Light** or **Dark**. Auto sets nothing;
Light and Dark set `data-theme` on the root, and the choice is kept in local storage. The dark
tokens are written twice in the stylesheet, under `prefers-color-scheme: dark` (unless the theme
is Light) and under `data-theme="dark"`. The map switches style to match (`map.setStyle`, after
which the app's overlays are added back), and the `theme-color` tags follow, so the browser's own
bars match the app.
