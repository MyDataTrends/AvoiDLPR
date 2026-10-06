# AvoiDLPR

**Driving directions that steer around license plate cameras.**

AvoiDLPR is a free map app that knows where automated license plate readers (ALPRs) are,
Flock Safety cameras included. It finds routes that pass as few of them as possible and shows
you what each route costs in cameras and in minutes. It runs in your phone's browser, installs
to your home screen like an app, and never sends your location or your destination anywhere.

<p align="center">
  <img src="docs/images/desktop.jpg" width="900" alt="AvoiDLPR on a laptop. A trip across Dallas has four route options, from the fastest (26 minutes, through 6 camera zones) to the one with the fewest cameras (28 minutes, through none). Each camera is drawn on the map as an arrow showing which way it points.">
</p>

> **Status:** a working prototype that isn't public yet. It covers Dallas today and is being
> expanded to major US cities. The public link will go here when it's live.

## Why

A license plate reader photographs every car that passes, not just the cars police are looking
for, and logs the plate, the time and the place. Flock Safety's cameras, now in thousands of US
communities, also record each car's make, color and features like roof racks and bumper
stickers. They're networked too, so police in one town can search cameras across the country.
In 2025, [records obtained by 404 Media](https://www.404media.co/ice-taps-into-nationwide-ai-enabled-camera-network-data-shows/)
showed more than 4,000 searches of Flock's national network for immigration enforcement over a
single year, and later reporting found
[searches tied to abortion cases](https://www.404media.co/flock-removes-states-from-national-lookup-tool-after-ice-and-abortion-searches-revealed/).

Put enough of these cameras on enough corners and they add up to a record of where everyone
drives. You can't opt out of being photographed, but you can choose which roads you take.
AvoiDLPR makes that choice easy to see. The [EFF's guide to ALPRs](https://www.eff.org/issues/automated-license-plate-readers-alpr)
is a good place to learn more.

## How it works

<p align="center">
  <img src="docs/images/phone-routes.jpg" width="270" alt="On a phone: the trip's route options in a panel under the map, with the fewest-cameras option selected.">
  &nbsp;&nbsp;
  <img src="docs/images/phone-drive.jpg" width="270" alt="Previewing a drive on a phone: a red banner reads 'In a camera zone: Flock Safety, reads plates heading N' as the route passes through a camera's shaded view.">
</p>

1. **A map of the cameras.** Volunteers map ALPRs on OpenStreetMap through
   [DeFlock](https://deflock.org), including each camera's brand and which way it points.
   AvoiDLPR picks up their map every hour.
2. **Camera zones.** A camera reads plates on the stretch of road in front of it. Flock
   cameras read rear plates, so they only log cars driving away from them, in one direction.
   When the map says which way a camera points, AvoiDLPR only counts it against routes that
   drive through its view in that direction. When it doesn't, AvoiDLPR assumes the camera can
   see every road around it.
3. **Route options.** For each trip you get the fastest route plus up to three others that
   trade a few minutes for fewer camera zones, each labelled with its time and its number of
   zones. The one marked *Recommended* avoids the most zones while adding no more than about
   10% to the trip. You pick.
4. **Preview the drive.** Watch your route play out on the map, with a warning before each
   camera and a banner while you're in its view.

To plan a trip, tap the map to set where you're starting (or use your current location) and
where you're going.

## Your privacy

- **Routing happens on your phone.** The app downloads your area's road map and camera list
  once, then works out every route on the device. Your location, start and destination are
  never sent anywhere. There's no AvoiDLPR server to send them to.
- **No account, no ads, no analytics.**
- Like any online map, it downloads map images for the area on screen. Those come from
  AvoiDLPR's own file host (not Google or Apple) and carry no account or identifier.
- After the first visit, route planning works offline too.

## Help improve the camera map

The map is only as good as the volunteers who build it, and plenty of cameras aren't on it yet.
If you know of one that's missing, or one that's wrong, add or fix it on
[DeFlock](https://deflock.org). AvoiDLPR picks up the change within the hour after DeFlock
publishes it. Every camera in the app links to its OpenStreetMap entry.

## Questions

**Is this legal?** Choosing your route is. AvoiDLPR doesn't interfere with cameras and doesn't
hide your plate. Don't cover or alter your plate either: that's illegal in most states.

**Does "0 camera zones" mean nobody saw me?** No. It means the route passes no *mapped*
cameras. Many cameras aren't mapped yet, and readers mounted on police cars move around.

**Why does the recommended route still pass a camera?** Sometimes there's no reasonable way
around one. AvoiDLPR shows you the options and lets you decide.

**Is AvoiDLPR part of Flock Safety or DeFlock?** No. It's an independent project that uses
DeFlock's public camera map.

**Does it work outside the US?** Not yet. Nothing about the approach is US-specific, so it can
cover anywhere the cameras are mapped.

## Coming next

- Live alerts while you drive, following your phone's GPS (today the alerts play in the
  preview)
- More cities, across the US
- Searching for an address instead of tapping the map
- Reporting a camera from inside the app
- Plugins that bring camera zones to open-source navigation apps

## For developers

AvoiDLPR is a static website plus static data files: no server, no database. A Python pipeline
turns OpenStreetMap and DeFlock data into a compact road file for each city. The app is
TypeScript: MapLibre GL with a self-hosted Protomaps basemap, and its own router, which runs in
a Web Worker on your phone. The code still uses the project's working name, FlockWatch.

- [docs/DEVELOPING.md](docs/DEVELOPING.md): building, testing and adding a city
- [docs/DEPLOY.md](docs/DEPLOY.md): hosting it for free (Cloudflare Pages and R2, GitHub Actions)
- [spike/routing/ROUTING.md](spike/routing/ROUTING.md): the camera-zone model and the routing
  math
- [spike/FINDINGS.md](spike/FINDINGS.md): where the camera data comes from and how good it is

Issues and pull requests are welcome.

## License

The code is licensed under the [Apache License 2.0](LICENSE).

The map data is not. Roads and camera locations come from OpenStreetMap under the
[Open Database License](https://opendatacommons.org/licenses/odbl/) (© OpenStreetMap
contributors), and the road packs and camera feeds this project builds from them carry the same
license. The basemap tiles are a Protomaps build of OpenStreetMap (also ODbL), the label fonts
are Noto Sans (SIL Open Font License), and MapLibre GL JS, PMTiles and the Protomaps style are
BSD-3-Clause.

AvoiDLPR isn't affiliated with Flock Safety. Flock Safety is a trademark of its owner.
