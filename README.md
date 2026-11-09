# MistWalk

MistWalk is a local-first walking exploration app. The world starts hidden in mist, and every 12-metre tile you cross with a valid walking GPS fix is cleared permanently.

This repository is the SvelteKit rebuild of the original static PWA. The old app is preserved unchanged in `legacy/` for reference.

## Stack

- **SvelteKit 3 + Svelte 5 + Vite 8** for the app and build.
- **TypeScript** in strict mode across the controller, core modules, adapters, and Svelte components.
- **Leaflet + OpenStreetMap** for the free, no-key default map.
- **Supabase** for optional email-and-password auth, member approval, invites, and one private backup row per approved user.
- **Vercel** for HTTPS hosting and the serverless adapter.
- **Vitest** for pure core tests.

The app works fully offline-first with only map tiles needing a network connection. Without Supabase environment variables it stays local-only and needs no account. When Supabase is configured, the deployment becomes approval-only: the owner must approve an account before the map, simulator, or cloud sync unlocks. Emails on the server-side owner allowlist are approved automatically as admins.

## Features

- **Live and simulator profiles** share the same walking gate, fog grid, and permanent tile unlocks.
- **Approval gate** for private deployments. Every new account waits for the owner, including invite-code holders.
- **Owner console** at `/admin` with its own email-and-password sign-in; only an approved admin can load member data.
- **Cross-device sync** for approved accounts, with automatic upload after saves and a restore prompt when another device is newer.
- **Journey record** with levels, streaks, repeat-visit heat, tile notes, favorite places, one combined history record per day, and route replay.
- **Accurate repeat visits** counted once per 12-metre tile per walk session, without resetting permanent unlocks or old heat.
- **Favorite places** with one place per tile, 1–5 star ratings, optional comments, and a large pseudo-3D highlight for the selected place.
- **Achievements** for exploration, distance, streaks, repeat visits, and notes.
- **Private tile notes and favorite places** stored locally, plus both in GeoJSON exports.
- **GPX/GeoJSON export** of tracks, notes, and places, and imported track overlays that never unlock tiles.
- **Nearest unexplored guide** and GPS quality feedback.
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

1. A visitor creates an account with email and password. No email code or confirmation link is sent when **Confirm email** is off.
2. A trigger creates a row in `mistwalk_members`. Addresses in `mistwalk_owner_emails` are approved admins; everyone else starts as pending.
3. New accounts see **Waiting for approval** and cannot use the map or simulator.
4. The owner signs in at `/admin` with the owner email and password, then approves or rejects the request.
5. Approved accounts unlock the map, simulator, and automatic cloud sync.
6. The owner can generate an invite code. Redeeming it only marks the request as invited; the owner still has to approve the account.
7. Revoking access locks that account out of backups on its next membership check.

The main portal at `/` has **Sign in** and **Create account** using email and password, with no visible owner link. Signing in there with an owner account redirects to `/admin`. The owner console also has its own password sign-in, and both use the same Supabase session. The schema prevents members from approving themselves or changing their own role.

## Supabase setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql).
3. Run [`supabase/auto-approve.sql`](supabase/auto-approve.sql). It creates the server-side owner allowlist and replaces the signup trigger.
4. Add the owner email in the SQL Editor. Keep this statement out of the repository:

```sql
insert into public.mistwalk_owner_emails (email)
values ('you@example.com')
on conflict (email) do nothing;

select public.mistwalk_sync_owner_emails();
```

Allowlisted accounts become approved admins on their first sign-in. Every other account stays pending.

5. In **Authentication > Providers > Email**:
   - Enable the Email provider.
   - Keep **Allow new users to sign up** on.
   - Turn **Confirm email** off. This is what makes email + password work without an OTP or confirmation link.
   - Set the minimum password length to 8 or more.

6. **Create the owner account before public sign-ups open.** In **Authentication > Users**, add the owner with a strong password and enable **Auto Confirm User**. If the owner account already exists, set its password from the dashboard or a one-time admin API call made outside this repository. Never put the service-role key or the owner password in tracked files or client-exposed variables.

   This step matters because the allowlist auto-approves the owner email. With confirmation off, whoever registers that email first would become the auto-approved admin.

7. In **Authentication > URL Configuration**, set the site URL to your deployment. Password auth does not need redirect links, but keeping the URL correct avoids confusion if recovery email is ever enabled.

8. Copy the project URL and the **anon public** key into `.env`:

```sh
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

Keep `.env` local; it is gitignored. Use the Vercel dashboard for production values.

9. Open `/admin`, sign in with the owner email and password, and confirm the dashboard loads. The main portal at `/` is where explorers create accounts.

If the owner account exists but was not auto-approved, run this once from the SQL Editor:

```sql
select public.mistwalk_promote_admin('you@example.com');
```

The helper only succeeds after the owner has signed in once, because it matches an existing `auth.users` row. It is revoked from `public`, `anon`, and `authenticated`, so it cannot be called through the API.

The anon key is designed to be public in browser bundles. Row Level Security is what protects member rows and backups. Never put a Supabase service-role key in a client-exposed variable.

### Password accounts

MistWalk does not send sign-in codes or magic links. Users create an account with email and password, and the owner approves the account from `/admin`.

- Passwords are handled by Supabase Auth; the app never stores them.
- Signed-in users can change their password from **Settings > Account and sync**.
- Forgotten passwords are reset by the owner. Supabase's email recovery link is not part of the normal flow.
- If **Confirm email** is left on, new sign-ups will require an email confirmation. The app detects this and tells the owner to turn it off.
- Enable CAPTCHA or rate limits in Supabase if the deployment is publicly reachable.

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
- The real security boundary is Supabase RLS: pending, rejected, and signed-out users cannot read or write backup rows. The `/admin` page has a password sign-in, but it only loads member data for an account with `role = 'admin'` and `status = 'approved'`. RLS and the admin-only RPC enforce the same rule.
- Member emails and statuses are visible to the owner. Approved members can read their own membership row and their own backup.
- Signing out stops cloud access but does not erase local maps from that browser. On a shared device, use **Reset profile** or **Wipe local data** before handing it over.
- Losing the owner password means losing the ability to manage the deployment. Keep the owner credentials in a password manager and keep the Supabase project recovery options safe. The app never stores passwords in browser storage.
- The code is public under the MIT license. That does not expose your Supabase project data as long as RLS stays enabled and the service-role key stays server-side.
- `.env` is gitignored and must stay local. Production values belong in Vercel's environment settings. Never commit keys, owner emails, or build output such as `.vercel/` or `.svelte-kit/`.
- The owner allowlist lives in `mistwalk_owner_emails`, which is server-only (RLS enabled, no client grants). Add addresses through the SQL Editor or an ignored `supabase/*.local.sql` file, never in tracked SQL.
- If a credential is ever exposed, rotate it in Supabase and Vercel before pushing, and scrub the commit from history.
- Before pushing, review `git status --short` and `git diff --cached`. Enable GitHub **Secret scanning** and **Push protection** so credential patterns are blocked at the remote.

## Free-tier notes

- **Vercel Hobby** is for personal, non-commercial projects. It includes 100 GB of bandwidth and roughly 1 million function invocations per month. Commercial use requires Pro.
- **Supabase Free** includes 500 MB database space, 5 GB egress, and 50,000 monthly active users. A backup snapshot is small, so space is not the first limit.
- Supabase Free projects pause after about one week of inactivity and can be restored from the dashboard. For a map that must stay online every day, add a small keep-alive ping or use a paid plan.
- Email is not part of the normal sign-in flow. Forgotten passwords are reset manually by the owner, so no SMTP provider is required.
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

- **Live profile**: geolocation fixes pass through `WalkGate` in `src/lib/core.ts`. Tiles unlock only at walking pace. The gate classifies each fix as walk, run, bike, motor, or car; running is too fast to count, while bike, motor, and car speeds pause unlocking for 45 seconds and move the anchor so a vehicle route never becomes a walked corridor.
- **Simulator profile**: a virtual walker moves at real walking speed while the UI can accelerate time. The same gate and grid logic applies.
- **Approval gate**: pending, rejected, and signed-out accounts cannot open the map or simulator. New accounts use email and password, without an email code or link. Allowlisted owner emails are auto-approved admins; everyone else waits for approval. The `/admin` page shows its own password sign-in and renders member data only for an approved admin account.
- **Persistence**: profiles and settings are written to `localStorage` and mirrored to IndexedDB.
- **Accounts**: `src/lib/cloud.ts` handles password sign-up/sign-in, membership, invites, and backup rows. `src/lib/mistwalk.svelte.ts` owns the gate, sync timer, and conflict prompt.
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
    core.ts                   Grid, walking gate, progress, notes, places, formatting
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
    admin/+page.svelte        Owner console with password sign-in and approval dashboard
static/                       Manifest, icons, font, service worker
supabase/schema.sql           Members, invites, backups, RPCs, and RLS policies
supabase/auto-approve.sql     Owner allowlist and signup auto-approval trigger
legacy/                       Original vanilla app, tests, and README
```

## Legacy app

`legacy/` contains the previous standalone build, its original `README.md`, service worker, tests, and deployment files. Run its tests with:

```sh
node --test legacy/tests/core.test.mjs
```

The Svelte test suite supersedes those tests while covering the same core behaviors plus regression tests for the walking gate and heading fixes.
