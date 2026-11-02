# MistWalk

MistWalk is a local-first walking exploration app. The world starts hidden in mist, and every 12-metre tile you cross with a valid walking GPS fix is cleared permanently.

This repository is the SvelteKit rebuild of the original static PWA. The old app is preserved unchanged in `legacy/` for reference.

## Stack

- **SvelteKit 3 + Svelte 5 + Vite 8** for the app and build.
- **TypeScript** in strict mode across the controller, core modules, adapters, and Svelte components.
- **Leaflet + OpenStreetMap** for the free, no-key default map.
- **Supabase** for optional email-code auth, member approval, invites, and one private backup row per approved user.
- **Vercel** for HTTPS hosting and the serverless adapter.
- **Vitest** for pure core tests.

The app works fully offline-first with only map tiles needing a network connection. Without Supabase environment variables it stays local-only and needs no account. When Supabase is configured, the deployment becomes approval-only: the owner must approve an account before the map, simulator, or cloud sync unlocks.

## Features

- **Live and simulator profiles** share the same walking gate, fog grid, and permanent tile unlocks.
- **Approval gate** for private deployments. Every new account waits for the owner, including invite-code holders.
- **Separate owner console** at `/admin` for approving, revoking, and rejecting accounts.
- **Cross-device sync** for approved accounts, with automatic upload after saves and a restore prompt when another device is newer.
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

To run without accounts, leave the Supabase variables empty. Local profiles, settings, backup import/export, the simulator, and the free map all continue to work.

## Access model

When Supabase is configured:

1. A visitor signs in with a 6-digit email code.
2. A trigger creates a `pending` row in `mistwalk_members`.
3. Pending and rejected accounts cannot use the map or simulator. They only see the access gate.
4. The owner approves or rejects the account from the `/admin` owner console.
5. Approved accounts unlock the map, simulator, and automatic cloud sync.
6. The owner can generate an invite code. Redeeming it only marks the request as invited; the owner still has to approve the account.
7. Revoking access locks that account out of backups on its next membership check.

Only the owner can open the owner console. The schema prevents members from approving themselves or changing their own role.

## Supabase setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
3. In **Authentication > Providers > Email**, keep email sign-ups enabled so explorers can create an account. Leave the email OTP length at 6 digits.
4. In **Authentication > URL Configuration**, set the site URL to your deployment. The code-only template does not use redirect links, but Supabase still uses this for auth emails.
5. Copy the project URL and the **anon public** key into `.env`:

```sh
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

6. Sign in once with the email that should own the map.
7. Promote that account in the SQL Editor:

```sql
select public.mistwalk_promote_admin('you@example.com');
```

The helper only succeeds after the owner has signed in once, because it matches an existing `auth.users` row. It is revoked from `public`, `anon`, and `authenticated`, so it cannot be called through the API.

8. Reload the app. The owner console is available at `/admin`; a shortcut also appears in **Settings > Account and sync**.

The anon key is designed to be public in browser bundles. Row Level Security is what protects member rows and backups. Never put a Supabase service-role key in a client-exposed variable.

### Email codes

MistWalk uses a one-time code instead of a magic link, so sign-in stays in the current browser or installed PWA.

1. Open **Authentication > Emails > Magic Link** in Supabase.
2. Replace the template with [`supabase/email-templates/magic-link.html`](supabase/email-templates/magic-link.html). It shows `{{ .Token }}` and contains no confirmation link.
3. Keep the built-in sender only for testing with project team addresses. It is limited to roughly two messages per hour and does not deliver to arbitrary users.
4. For real invited users, connect custom SMTP under **Authentication > SMTP Settings**. Free tiers from Resend, Brevo, or similar providers are enough for a small private group.

Writing over the built-in template removes the Vercel link that older emails used. If a user still has an old link, they can ignore it and request a fresh code. Supabase rate-limits OTP requests, so wait a minute between resend attempts if the app reports a rate-limit error.

## Cloud sync behavior

Cloud sync stores a full snapshot of both profiles and settings in `public.mistwalk_backups`.

- Approved accounts upload automatically about 9 seconds after a local save, and immediately when the page is hidden.
- On sign-in, if the remote copy is newer than the local copy, MistWalk asks before replacing local data.
- While the app is open, a remote-newer check runs on focus at most once every 30 seconds and shows a notice.
- Conflicts are last-write-wins. There is no field-level merge.
- A previously approved device can still open the live map offline using cached approval. Cloud writes retry when the connection returns.
- **Restore cloud** replaces both local profiles and settings after confirmation.
- **Delete cloud copy** removes only the remote row. Auto-sync uploads a new copy after the next local save unless the account signs out or access is revoked.

The backup is not end-to-end encrypted. It is readable by its owner under RLS and by the Supabase project. Do not store secrets in notes.

## Vercel deployment

The project uses `@sveltejs/adapter-vercel`.

1. Push the repository to GitHub.
2. Import it in Vercel.
3. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` under **Project Settings > Environment Variables** if you want accounts and sync.
4. Deploy.

Without the environment variables, the deployed app remains local-only and shows no gate.

The service worker is served from `/sw.js` with revalidation headers via `vercel.json`.

## Security and privacy limits

- The app is a static, client-rendered shell (`ssr = false`, `prerender = true`). Client-side gates can be bypassed by modifying a local copy of the code.
- The real security boundary is Supabase RLS: pending, rejected, and signed-out users cannot read or write backup rows. The client-side owner console only works for an account with `role = 'admin'` and `status = 'approved'`; RLS and the admin-only RPC enforce the same rule.
- Member emails and statuses are visible to the owner. Approved members can read their own membership row and their own backup.
- Signing out stops cloud access but does not erase local maps from that browser. On a shared device, use **Reset profile** or **Wipe local data** before handing it over.
- Losing access to the owner email means losing the ability to manage the deployment. Keep the Supabase project credentials safe.
- The code is public under the MIT license. That does not expose your Supabase project data as long as RLS stays enabled and the service-role key stays server-side.

## Free-tier notes

- **Vercel Hobby** is for personal, non-commercial projects. It includes 100 GB of bandwidth and roughly 1 million function invocations per month. Commercial use requires Pro.
- **Supabase Free** includes 500 MB database space, 5 GB egress, and 50,000 monthly active users. A backup snapshot is small, so space is not the first limit.
- Supabase Free projects pause after about one week of inactivity and can be restored from the dashboard. For a map that must stay online every day, add a small keep-alive ping or use a paid plan.
- Built-in Supabase email is limited to project team addresses and a low hourly rate. Invited explorers need custom SMTP.
- OpenStreetMap tiles are donated infrastructure. Respect the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Nominatim search is throttled client-side to roughly one request per second. It is for interactive search, not bulk geocoding.
- Google Maps is the only path that can ever create a bill. It stays optional and off by default.

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

- **Live profile**: geolocation fixes pass through `WalkGate` in `src/lib/core.ts`. Tiles unlock only at walking pace; vehicle-speed fixes pause unlocking for 45 seconds and move the anchor so a car route never becomes a walked corridor.
- **Simulator profile**: a virtual walker moves at real walking speed while the UI can accelerate time. The same gate and grid logic applies.
- **Approval gate**: pending, rejected, and signed-out accounts cannot open the map or simulator. The separate `/admin` owner console renders only for an approved admin account.
- **Persistence**: profiles and settings are written to `localStorage` and mirrored to IndexedDB.
- **Accounts**: `src/lib/cloud.ts` handles OTP sign-in, membership, invites, and backup rows. `src/lib/mistwalk.svelte.ts` owns the gate, sync timer, and conflict prompt.
- **Map**: OpenStreetMap is default and needs no key. Google Maps is optional via a browser key stored locally.
- **PWA**: the service worker caches the app shell and hashed assets, never user exploration data.

## Project layout

```text
src/
  app.css                     Visual system, including access gate and member UI
  app.html                    PWA metadata and document shell
  lib/
    components/               Svelte UI (map, HUD, modals, onboarding, access gate)
    types.ts                  Shared TypeScript domain types
    core.ts                   Grid, walking gate, progress, notes, formatting
    features.ts               Achievements, guide, GPS quality, challenges
    track.ts                  GPX and GeoJSON import/export
    fog.ts                    Canvas fog renderer
    map-osm.ts                Leaflet adapter
    map-google.ts             Optional Google Maps adapter
    storage.ts                localStorage + IndexedDB persistence
    cloud.ts                  Supabase auth, membership, invites, backup bridge
    mistwalk.svelte.ts        Application controller and state
  routes/
    +layout.ts                Client-only prerendered shell
    +layout.svelte            CSS imports
    +page.svelte              App entry
    admin/+page.svelte        Separate owner console
static/                       Manifest, icons, font, service worker
supabase/schema.sql           Members, invites, backups, RPCs, and RLS policies
supabase/email-templates/     Code-only Supabase email template
legacy/                       Original vanilla app, tests, and README
```

## Legacy app

`legacy/` contains the previous standalone build, its original `README.md`, service worker, tests, and deployment files. Run its tests with:

```sh
node --test legacy/tests/core.test.mjs
```

The Svelte test suite supersedes those tests while covering the same core behaviors plus regression tests for the walking gate and heading fixes.
