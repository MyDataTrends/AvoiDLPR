# Deploying AvoiDLPR

AvoiDLPR is a static site plus static data files. There is no server, database or API, so
hosting is free-tier friendly and there's nothing to keep running.

```
                  GitHub (this repo)
                 /        |         \
   push to main /         |hourly    \monthly
               v          v           v
  Cloudflare Worker   refresh-cameras  build-data      GitHub Actions
   (the app, ~2 MB)        |            |
          |                +-----+------+
          |                      v
          |         Cloudflare R2 bucket (the data)
          |    regions.json  packs/  places/  basemap/  cameras/
          |                      ^
          +------ fetches -------+          your phone: the app + data come from the two hosts,
                                            routing and search happen on the phone
```

| Piece | Where | What it is |
|---|---|---|
| The app | Cloudflare Worker (static files only) | `apps/web`, built by Vite: about 2 MB of HTML, JS and CSS, plus the service worker and the headers file |
| The data | Cloudflare R2 bucket | For each of 135 US metro areas: a gzipped road pack (1 to 13 MB), a search index of its addresses and places (a few MB), a Protomaps basemap extract (20 to 120 MB) and a camera feed refreshed hourly; plus fonts and sprites. About 7 GB in all, described by `regions.json` |
| Data refresh | GitHub Actions | `build-data` (monthly) and `refresh-cameras` (hourly) |

The app fetches `regions.json` first, and everything else is named in it, so adding a city is a
data change. Big files have content-hashed names and are cached forever; the camera feeds and
`regions.json` are revalidated on every load. See `pipeline/release.py` for the layout.

## The checklist for when you're at your computer

Roughly 45 minutes, most of it clicking through dashboards. Do these in order.

### 1. Put the repository on GitHub

Done: [MyDataTrends/AvoiDLPR](https://github.com/MyDataTrends/AvoiDLPR), public (which keeps
Actions minutes free, and an open project is an easier pitch).

- GitHub created the repository with a LICENSE and a README, so the first push needed that commit
  merged in (`git pull origin main --allow-unrelated-histories`, keep both, push).
- The code is Apache-2.0: permissive, with a patent grant, so a Waze or DeFlock integration can
  adopt it without asking. The data has its own license (see "Licensing" below).
- CI (`.github/workflows/ci.yml`) runs on every push. The hourly and monthly data jobs are
  skipped, not failing, until the `R2_BUCKET` variable from step 3 exists.

### 2. Create the data bucket (Cloudflare R2)

1. Create a free Cloudflare account, then **R2 Object Storage** and **Create bucket**
   (for example `avoidlpr-data`). R2 asks for a payment method but the free tier is generous:
   10 GB storage, 1M writes and 10M reads a month, and no download charges.
2. **Public access.** Bucket **Settings > Public access**. For getting started, enable the
   `r2.dev` URL (looks like `https://pub-<hash>.r2.dev`). Cloudflare rate-limits it and says it's
   not for production, which is fine for a demo and a pitch. For launch, connect a custom domain
   to the bucket instead (about $10 a year for a domain on Cloudflare DNS), which also gets
   Cloudflare's cache in front of the files.
3. **CORS.** Bucket **Settings > CORS policy**, add (replace the first origin once you know your
   app's address in step 5; keep localhost for development):
   ```json
   [
     {
       "AllowedOrigins": ["https://map.avoidlpr.workers.dev", "http://localhost:5173"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range", "if-match", "if-none-match"],
       "ExposeHeaders": ["etag", "content-range", "content-length", "accept-ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```
   The map is one big file read in byte ranges, so `range` must be allowed. Without this the
   app loads but the map stays blank. If the dashboard wants a different shape, Cloudflare's
   R2 CORS docs are the reference.
4. **API token.** R2 overview > **Manage API tokens** > **Create API token**, permission
   *Object Read & Write*, limited to your bucket. Copy the **Access Key ID**, **Secret Access
   Key** and your **Account ID** (shown on the R2 overview page). You only see the secret once.

### 3. Give GitHub the keys

Repository **Settings > Secrets and variables > Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `R2_ACCOUNT_ID` | your Cloudflare account ID |
| Secret | `R2_ACCESS_KEY_ID` | from the API token |
| Secret | `R2_SECRET_ACCESS_KEY` | from the API token |
| Variable | `R2_BUCKET` | the bucket name |

The three secrets go under the **Secrets** tab and the bucket name under **Variables**, with
exactly these names. Both data workflows check them first: if one is missing, the run fails at
"Check the bucket is set up and reachable" and names it; if they're all there but the bucket
can't be listed, it says that instead (usually the account ID, or a token scoped to another
bucket).

### 4. Publish the data

**Actions > Build map data > Run workflow** (leave "publish" ticked). It builds all 135 areas in
ten parallel jobs, one per group of neighbouring states, and publishes them: about 15 to 20
minutes. It was dry-run on GitHub before you set this up, so it's known to build every area; this
run is the first to upload. The run's summary page lists every area with its size.

- Its log prints the pmtiles CLI's SHA-256: save it as the repository variable `PMTILES_SHA256`
  and the job will refuse any other file in future.
- Check it worked: open `https://<public-url>/regions.json`. You should see the manifest.
- From now on the hourly camera refresh runs by itself (it waits for a published manifest).

### 5. Deploy the app (a Cloudflare Worker)

The app is static files, served by a Worker with no code of its own: `wrangler.jsonc` at the repo
root tells it where the built files are (`apps/web/dist`). **Workers & Pages > Create > Import a
repository**, choose the repository, then:

| Setting | Value |
|---|---|
| Worker name | `map`: it has to match `name` in `wrangler.jsonc` |
| Production branch | `main` |
| Build command | `npm ci && npm run build` |
| Deploy command | `npx wrangler deploy` (the default) |
| Root directory | empty (the repo root) |
| Build variable | `NODE_VERSION` = `22` |
| Build variable | `VITE_DATA_BASE` = your bucket's public URL, no trailing slash |

The two variables go under **Settings > Build > Variables and secrets**: they're *build*
variables, not the Worker's runtime ones. `VITE_DATA_BASE` is baked in when the app is built,
and also becomes the data host in the Content-Security-Policy, so the browser will refuse to
talk to anything else; change it and the app has to be rebuilt (retry the deployment). After the
first deploy, copy the Worker's address into the R2 CORS policy from step 2: it's
`https://map.avoidlpr.workers.dev`, the Worker's name followed by the account's workers.dev
subdomain (set under **Workers & Pages > Overview > Subdomain**). Every push to `main` redeploys.

(Cloudflare Pages, now the legacy option, works too: build output directory `apps/web/dist`,
and the same build command and variables.)

### 6. Try it on your phone

1. Open the app's address. It asks where you drive: tap **Use my location** (or pick from the
   list). Your area's road map downloads, a few MB.
2. Tap the map for a destination, pick a route, and tap **Start**. Drive with the app open and
   the screen on; it warns before each camera zone and chimes inside one.
3. **iPhone:** Safari > Share > **Add to Home Screen**. **Android:** Chrome menu > **Install
   app** (the Settings panel in the app also shows an install button there).
4. Open it from the home screen: it runs full-screen with no browser bar.
5. Turn on **airplane mode** and open it again. The app, road network and cameras are cached, so
   routing still works; only new map tiles need a connection.

### 7. Before you tell anyone

- Add the app's address to the CORS policy and decide on the custom domain.
- Skim "Licensing" and "Known gaps" below.

## What runs automatically afterwards

| What | When | Where it runs |
|---|---|---|
| Tests, type-check, build | every push and pull request | `ci.yml` |
| App redeploy | every push to `main` | Cloudflare (Workers Builds) |
| Camera feeds refreshed from DeFlock | hourly | `refresh-cameras.yml` |
| Roads updated, changed areas' packs checked and republished | nightly (07:30 UTC) | `build-data.yml` (roads) |
| Road packs, search indexes and basemaps rebuilt from fresh downloads | monthly (the 3rd), or on demand | `build-data.yml` (full) |
| Superseded road packs, search indexes and basemaps deleted | daily (05:00 UTC), a day after they're replaced | `refresh-cameras.yml` |

Notes:
- GitHub disables scheduled workflows in a public repository after 60 days with no repository
  activity. If the hourly refresh goes quiet, re-enable it in the Actions tab.
- The camera refresh won't publish a feed that shrank by more than half, and fails loudly
  instead, so a DeFlock outage can't blank your map.
- A build that fails for some areas still publishes the rest: those areas keep their current
  files. Every area is checked against the real state borders first, so one that
  reaches into a state it doesn't list fails the run instead of shipping with a hole in it.
- **Build map data** with "publish" unticked is a dry run: it builds and reports, uploads nothing.
  Its "mode" picks the monthly build (full) or the nightly update (roads).
- Search indexes are only built by the full build. Until an area has one (a new deployment, or
  an area whose index failed to build), the app says search isn't ready there yet and map taps
  still work. To get them sooner than the 3rd, run **Build map data** in full mode.
- The nightly update's roads live in GitHub's Actions cache (10 GB a repository; old entries
  are evicted). If they're evicted, the next run downloads those states again.

## Adding a city

1. Add an entry to `pipeline/regions.json`: `id`, `name`, `clip_bbox` (west, south, east,
   north) and `geofabrik`, the Geofabrik extract of every state the rectangle reaches into, home
   state first (it files the area under that state in the app). Optionally an `example` trip.
2. Run **Build map data** with that region's id. The first job checks the state list; the run
   summary shows the new area's size. Keep an area to a metro: the build refuses one over a
   million road edges (the biggest today, Dallas, is half that).
3. The app picks it up from `regions.json` with no redeploy.

## Costs and limits (free tier, October 2026)

| | Limit | Why it's comfortable |
|---|---|---|
| Workers static files | 25 MiB per file, 20,000 files, requests for static files free | The app is about 2 MB; big files live in R2 |
| R2 | 10 GB stored, 1M writes and 10M reads a month, **no egress fees** | The data is about 7 GB, and the daily cleanup keeps one copy. The hourly feeds are about 100,000 writes a month. A map tile is one read; rough guess a few hundred per session, so tens of thousands of sessions a month before reads cost anything (about $0.36 per million after) |
| GitHub Actions | Free for public repositories | An hourly job of about a minute, a nightly road update, and a monthly build of about two hours of runner time (20 minutes on the clock) |
| Geofabrik, Protomaps | Free downloads, fair use | The monthly build fetches each state once (about 10 GB) and cuts each basemap out of Protomaps' daily planet build; the nightly update only fetches Geofabrik's daily change files |

These are from public pricing pages in October 2026 and change; check before relying on them.

## Keeping the data fresh

Cameras refresh hourly. Roads are checked every night, and an area's road pack is replaced when
its roads have changed enough to matter, without downloading the country again and without
making phones fetch an area whose roads didn't change. The monthly build remains the baseline:
fresh downloads, new basemaps, and a correction for anything the nightly updates miss.

1. **Roll the roads forward.** Each state is kept as its roads only, in GitHub's Actions cache
   (`pipeline/roads.py`). Every night it takes the change files Geofabrik has published since
   (a few MB a day per state) from the exact sequence it holds, applies them with pyosmium and
   filters again. A state with no cached copy, or changes the server no longer has, starts again
   from a fresh download.
2. **Rebuild the packs, not the basemaps.** Every area's road pack is rebuilt from the updated
   roads. Basemaps are cosmetic and search indexes change slowly, so both stay monthly (a
   brand-new area gets a basemap).
3. **Same roads, same file.** A pack carries a fingerprint of its routing content (the graph,
   not the build date). A rebuild with the live fingerprint is *unchanged*: nothing is uploaded
   and phones keep what they have.
4. **Check before switching.** A changed pack is loaded next to the live one by the router's own
   check (`packages/router/bin/verify.ts`): it has to decode, keep its road-edge count within
   −15%/+20% of the live pack's, and route 40 sample trips in about the same times, with few
   outliers. One that fails is *held back*: the area keeps its live pack, and the run summary
   says why.
5. **Only changes worth a download.** The check also measures the share of road edges that
   changed. The nightly update republishes an area when that's 1% or more, or when its live pack
   is a week old; a smaller fix is *deferred* until one of those is true. (A Dallas pack is a
   12.5 MB download; daily replacements for one-street fixes would cost phones hundreds of MB a
   month.) Both thresholds are at the top of `pipeline/decide.py`.
6. **Switch, then drop the old file.** `regions.json` moves to the new files in one write, and
   only when something changed; the manifest it replaces is kept as `regions.prev.json`. The
   daily cleanup deletes a pack, search index or basemap once no manifest has named it for a
   day, and never a file uploaded in the last day.
7. **On the phone, the old pack stays until the new one is proven.** The app checks a new pack's
   SHA-256 against the manifest and decodes it; only then does it tell the service worker to drop
   older versions. A pack that fails is evicted from the cache (so the next try downloads it
   again) and the app routes on the last good one, saying so. An app left open, or kept in memory
   as an installed app, looks for news whenever it comes back on screen and every half hour:
   new cameras apply at once, and a new pack, search index or basemap waits until no trip is
   being driven or previewed. The panel's footer says how current the roads and cameras are.

## Security and privacy posture

- **Nothing about a trip leaves the device.** Routing happens in the browser, and so does
  search: there is no geocoding service. The app downloads the area's search index and matches
  what's typed in a worker. The app's Content-Security-Policy (`apps/web/vite.config.ts`,
  emitted as `_headers`) lets the page connect only to itself and the data host; the production
  end-to-end test proves a request to any other origin is blocked.
- Names of searched places stay out of the link: a shared link carries coordinates only, as
  before.
- A GPS fix is used in memory and never written to the URL or storage, including while
  navigating. The app remembers which area you picked (on the device), and a shared link only
  names the area when it also carries pins.
- `Permissions-Policy` limits geolocation to the app's own origin and disables camera, mic and
  payment APIs.
- The data host only serves public files. The R2 API token lives in GitHub secrets, scoped to the
  one bucket.
- No analytics. If you add some later, choose a cookieless service that never sees coordinates.

## Licensing and attribution

- **Camera locations and roads** come from OpenStreetMap (ODbL). The basemap is a Protomaps
  build of OpenStreetMap (also ODbL). The app shows the required attribution on the map. If you
  publish derived data (the road packs, search indexes and camera feeds are derived databases),
  the ODbL's attribution and share-alike terms apply to it: keep them public and credited. Read
  the license before you commercialise; this is not legal advice.
- **Fonts** (Noto Sans, from Protomaps' basemap assets) are SIL OFL.
- **Code:** Apache-2.0 (`LICENSE`).
- **Camera data** is crowdsourced and sometimes wrong. The UI says what each zone assumes, and
  every camera links to OpenStreetMap so errors can be fixed at the source.

## Known gaps

- The data workflows have been dry-run on GitHub (the monthly build, and the nightly update both
  from a fresh download and rolling cached roads forward) but have never published to a bucket.
- Areas are separate maps: a trip from one to another (Charlotte to Raleigh) can't be planned
  unless one area holds both ends. Neighbouring areas overlap so most trips inside a metro work;
  routing across the country would need the road network in tiles, loaded along the way.
- Live navigation needs the app open with the screen on: phones pause web pages in the
  background. There are no turn-by-turn directions yet, just the route line and camera alerts.
- Search knows what OpenStreetMap knows. House numbers are thorough in some counties and sparse
  in others; a number that isn't mapped is placed between its neighbours (and marked
  approximate) or, failing that, the app offers the street. There's no typo tolerance yet, and a
  search only covers the open area.
- Offline use covers the app, the road network and the cameras, but not map tiles. An opt-in
  "download this area" for tiles is the next step for a fully offline map.
- Installed-app behaviour (home screen on iOS and Android) hasn't been checked on real devices:
  it was tested in an emulator, including offline starts.
- No uptime monitoring or error reporting, deliberately: both would need to see something.
- Reporting a camera still sends people to openstreetmap.org to edit; in-app OSM sign-in is
  planned, and works without a server.
