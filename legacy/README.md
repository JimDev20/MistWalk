# MistWalk

**A private, free walking exploration simulator.** The whole map begins under mist. Walk the real world, and each 12-metre tile you cross lifts the fog permanently. Come back next week and the places you earned are still yours.

No account. No backend. No subscription. One browser, one explorer.

The interface follows a flat true-black app-screen direction: Archivo, one icy signal hue, no glass or gradients in the chrome. The map is the only textured field.

## What it does

- **Real-time GPS tracking** with `navigator.geolocation.watchPosition()`. A 52 px male walker avatar marks your live position, with a heading wedge, accuracy ring and breadcrumb trail.
- **Walking-only unlocking.** The gate rejects movement faster than about 10.8 km/h and locks out for 45 seconds when a vehicle is detected. A vehicle's route is never turned into a walked corridor later.
- **Permanent fog-of-war.** Tiles are 12 m × 12 m Web Mercator cells. Once walked, they stay revealed in the save forever. The map is fully opaque between them.
- **A separate simulator profile.** Tap the map and a virtual walker follows at 1.35 m/s through the same walking gate. Simulator progress never touches the live map.
- **Local-first storage.** `localStorage` is the fast primary copy; IndexedDB is the durable mirror. If localStorage is lost, the map is recovered from IndexedDB and repaired automatically.
- **Free map first.** OpenStreetMap tiles need no account, key, or billing. Google Maps is an optional mode if you want it.
- **Installable PWA.** Add it to your home screen; the app shell works offline. Map tiles still need a connection.
- **Backup/restore.** One JSON file contains both profiles and settings.

## Quick start (computer, with real GPS)

You need Python 3 for the included local server. There is no build step and no npm install.

1. Double-click **`start.bat`** (or run `python server.py --open`).
2. Open **<http://127.0.0.1:4173>** if it does not open automatically.
3. Press **Enable live GPS**, allow location access, and walk.

`localhost` and `127.0.0.1` count as secure origins, so GPS works on the same computer. Opening `index.html` directly from disk is **not** supported: ES modules and geolocation need a real HTTP origin.

### Try it without going outside

1. Press **Try the simulator**.
2. Use the **search** button to jump to your neighbourhood, or keep the default centre.
3. Press **Place me**, then tap the map. The virtual walker heads there at walking speed.
4. The **1×** button cycles 4× and 20× time compression. The gate still measures 1.35 m/s, so only the clock is compressed.

## Using it on a phone (real walking)

Browsers only expose GPS to **secure contexts**:

- `http://localhost` works on the same computer.
- A phone must use **HTTPS**. `http://192.168.x.x` will not give you GPS.

The easiest zero-cost options are a free static host:

- **GitHub Pages.** Upload the contents of this folder to a repository and enable Pages in Settings.
- **Cloudflare Pages** or **Netlify Drop.** Drag the folder in. Use no build command and publish directory `/`.
- Any static host you already have.

All paths are relative, so the app works from a subdirectory such as `https://you.github.io/mistwalk/`. Open the HTTPS link on your phone, allow location, then use **Add to Home Screen** for a full-screen PWA.

If you want to keep the server on your computer and expose it temporarily, a trusted HTTPS tunnel also works. Do not use a plain LAN HTTP address for GPS.

## Google Maps (optional)

The default **OpenStreetMap** mode is free and needs no key. It is the recommended mode for a zero-cost single-user setup.

The position card also has a free **Google Maps** link that opens your current coordinates in Google Maps. It needs no key. The embedded Google Maps basemap is the optional part that needs a key.

To use Google Maps:

1. Get a **Maps Demo Key** (no credit card) at <https://mapsplatform.google.com/maps-demo-key/>, or use a regular Google Maps Platform key with the **Maps JavaScript API** enabled.
2. Restrict the key to your HTTP referrers, for example:
   - `http://localhost:4173/*`
   - `http://127.0.0.1:4173/*`
   - `https://your-site.example/*`
3. Open MistWalk, then **Settings**, then **Google Maps**. Paste the key and press **Connect**.

If the key is rejected or the network is unavailable, MistWalk falls back to the free map and keeps working.

> **Cost note:** the free demo key needs no card, and regular Google keys include a free monthly usage allowance. Google Maps Platform can still bill above its quota. The default OpenStreetMap mode has no billing relationship at all. If you use a regular Google key, set budget alerts.

## How unlocking works

| Rule | Value |
| --- | --- |
| Tile size | 12 m × 12 m (Web Mercator grid) |
| Position accuracy needed | ≤ 35 m |
| Walking speed limit | 3.0 m/s (10.8 km/h) |
| Vehicle lockout | 45 seconds after a too-fast fix |
| Permanent save | `localStorage` + IndexedDB mirror |
| Live profile | Only real GPS fixes |
| Simulator profile | Virtual fixes, stored separately |

The position is snapped to the tile that contains it, and the straight segment between two accepted fixes is sampled every 5 m so a fast walking update does not skip a tile. A vehicle fix never earns tiles; when walking resumes, the anchor moves to the vehicle's last position so the road behind you cannot be retroactively revealed.

GPS is not perfect. Near a tile edge, normal GPS jitter can occasionally unlock an adjacent tile. That is a property of consumer GPS, not a vehicle loophole.

## Privacy

- No account, no server, no analytics, no upload of your trail.
- Exploration data lives in this browser only.
- Map tiles are requested from OpenStreetMap (or Google if you opt in). Those providers see the map area being viewed, as with any map site.
- Search queries go to the free OpenStreetMap Nominatim geocoder.
- A Google key, if used, is stored in this browser's local storage. Restrict it by referrer.

## Backups and "forever"

"Forever" means the save survives reloads, browser restarts, and normal use. It cannot survive clearing all site data or losing the device. For that:

- In **Settings**, choose **Export backup** to write `mistwalk-backup-YYYY-MM-DD.json` containing both profiles.
- **Restore backup** replaces both local profiles.
- The IndexedDB mirror can recover the map if only localStorage is cleared, but it lives in the same browser profile. Export is the real portable backup.

## File map

```
index.html                  app shell
assets/app.js               UI, geolocation, simulator, orchestration
assets/core.js              grid, walking gate, progress logic (pure)
assets/storage.js           localStorage + IndexedDB, backup
assets/fog.js               canvas fog-of-war, trail, marker
assets/map-osm.js           Leaflet adapter + free OSM basemaps
assets/map-google.js        optional Google Maps overlay adapter
assets/style.css            responsive interface
assets/vendor/leaflet.*     vendored Leaflet 1.9.4 (no CDN)
sw.js                       app-shell service worker
manifest.webmanifest        PWA manifest
server.py / start.bat       zero-dependency local server
tests/core.test.mjs         Node tests for the rules
```

## Tests

```powershell
node tests/core.test.mjs
```

The test suite covers Mercator round-trips, tile bounds, interpolation, the walking gate, vehicle lockout, weak GPS, resume jumps, permanence, levels, and formatting. The app-level checks were also run against a headless Chrome instance with emulated GPS and persistence reloads.

## Known limits

- Tracking runs while the page/PWA is open. Browsers do not allow a normal web page to track GPS in the background all day.
- Battery use is higher with high-accuracy GPS, screen wake lock, and map tiles. The app asks for high accuracy because tile unlocking depends on it.
- OSM's public tile service is best-effort for personal, low-volume use. Heavy or commercial use needs a tile provider of your own.
- Google Maps mode requires a Google account/key and is not covered by the "zero cost" promise of the free OSM mode.
- The simulator is deliberately usable for testing and indoor demos; live and simulator maps are separate.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the Open Database License.
- [Leaflet](https://leafletjs.com/) 1.9.4, BSD-2-Clause, vendored locally.
- Alternative basemaps: [OSM France](https://openstreetmap.fr/) and [CyclOSM](https://www.cyclosm.org/).
- Google Maps is a trademark of Google LLC. Optional mode only.
- MistWalk code: MIT, see `LICENSE`.

Built as a single-user, local-first system. The mist does not need a cloud.
