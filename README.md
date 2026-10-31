# MistWalk

MistWalk is a local-first walking exploration app. The world starts hidden in mist, and every 12-metre tile you cross with a valid walking GPS fix is cleared permanently.

This repository is the SvelteKit rebuild of the original static PWA. The old app is preserved unchanged in `legacy/` for reference.

## Stack

- **SvelteKit 3 + Svelte 5 + Vite 8** for the app and build.
- **TypeScript** in strict mode across the controller, core modules, adapters, and Svelte components.
- **Leaflet + OpenStreetMap** for the free, no-key default map.
- **Supabase** for optional magic-link auth and one private JSON backup row per user.
- **Vercel** for HTTPS hosting and the serverless adapter.
- **Vitest** for pure core tests.

No paid service is required. The app works fully offline-first with only the map tiles needing a network connection. Supabase cloud backup is optional.

## Features

- **Live and simulator profiles** share the same walking gate, fog grid, and permanent tile unlocks.
- **Journey record** with levels, streaks, visit heat, notes, one combined history record per day, and route replay.
- **Achievements** for exploration, distance, streaks, repeat visits, and notes.
- **Private tile notes** stored locally, plus notes in GeoJSON exports.
- **GPX/GeoJSON export** of tracks and notes, and imported track overlays that never unlock tiles.
- **Nearest unexplored guide** and GPS quality feedback.
- **Favorites** highlight tiles crossed more than once.
- **Local friend challenges** via shareable URL targets, without a server or leaderboard.
- **Accessibility and display controls** for units, theme, high contrast, and reduced motion.
- **Backups** locally as JSON, optionally through Supabase, plus PNG share cards.
- **Free default map** with optional Google Maps; the app stays usable without a key.

## Local development

Requirements: Node.js 20.19+ (Node 24 is recommended) and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Open the URL printed by Vite. GPS works on `http://localhost` because browsers treat it as a secure context.

To run without Supabase, leave the environment variables empty. Local profiles, settings, backup import/export, the simulator, and the free map all continue to work.

## Supabase setup (optional)

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
3. In **Authentication → URL Configuration**, set the site URL to your deployment and add redirect URLs for:
   - `http://localhost:5173`
   - your production Vercel URL
4. Copy the project URL and the **anon public** key into `.env`:

```sh
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

The anon key is designed to be public in browser bundles. Row Level Security in the schema is what protects each user's backup. Never put a Supabase service-role key in a `VITE_` variable.

Cloud backup is a full snapshot of both profiles and settings. It is not realtime sync, and it is not end-to-end encrypted; the database row is readable by its owner under RLS and by the Supabase project. Upload or restore only when you choose.

## Vercel deployment

The project uses `@sveltejs/adapter-vercel`.

1. Push the repository to GitHub.
2. Import it in Vercel.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under **Project Settings → Environment Variables** if you enabled cloud backup.
4. Deploy.

The free Vercel plan is enough for this static, prerendered app. The service worker is served from `/sw.js` with revalidation headers via `vercel.json`.

## Commands

```sh
npm run dev       # development server
npm run build     # production build
npm run preview   # preview the production build
npm run check     # Svelte and TypeScript diagnostics
npm test          # Vitest suite
npm run lint      # Prettier + ESLint
npm run format    # write formatting fixes
```

## How the flow works

- **Live profile** — geolocation fixes pass through `WalkGate` in `src/lib/core.ts`. Tiles unlock only at walking pace; vehicle-speed fixes pause unlocking for 45 seconds and move the anchor so a car route never becomes a walked corridor.
- **Simulator profile** — a virtual walker moves at real walking speed while the UI can accelerate time. The same gate and grid logic applies.
- **Persistence** — profiles and settings are written to `localStorage` and mirrored to IndexedDB. `src/lib/cloud.ts` adds optional Supabase backup around the same local data.
- **Map** — OpenStreetMap is default and needs no key. Google Maps is optional via a browser key stored locally.
- **PWA** — the service worker caches the app shell and hashed assets, never user exploration data.

## Project layout

```text
src/
  app.css                     Original visual system, adapted for SvelteKit
  app.html                    PWA metadata and document shell
  lib/
    components/               Svelte UI (map, HUD, modals, onboarding)
    types.ts                  Shared TypeScript domain types
    core.ts                   Grid, walking gate, progress, notes, formatting
    features.ts               Achievements, guide, GPS quality, challenges
    track.ts                  GPX and GeoJSON import/export
    fog.ts                    Canvas fog renderer
    map-osm.ts                Leaflet adapter
    map-google.ts             Optional Google Maps adapter
    storage.ts                localStorage + IndexedDB persistence
    cloud.ts                  Supabase auth and backup bridge
    mistwalk.svelte.ts        Application controller and state
  routes/
    +layout.ts                Client-only prerendered shell
    +layout.svelte            CSS imports
    +page.svelte              App entry
static/                       Manifest, icons, font, service worker
supabase/schema.sql           Backup table and RLS policies
legacy/                       Original vanilla app, tests, and README
```

## Free-tier notes

- OpenStreetMap tiles are donated infrastructure. The app keeps this as the default and avoids bulk requests. Respect the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Nominatim search is throttled client-side to roughly one request per second. It is for interactive search, not bulk geocoding.
- Supabase's free tier covers auth and a very small backup table comfortably.
- Google Maps is the only path that can ever create a bill. It stays optional and off by default.

## Legacy app

`legacy/` contains the previous standalone build, its original `README.md`, service worker, tests, and deployment files. Run its tests with:

```sh
node --test legacy/tests/core.test.mjs
```

The Svelte test suite supersedes those tests while covering the same core behaviors plus regression tests for the walking gate and heading fixes.
