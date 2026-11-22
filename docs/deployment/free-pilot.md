# Aman Team Shifts: free-hosted pilot runbook

This runbook prepares, but does not deploy, a limited pilot:

- Cloudflare Pages Free for the static PWA.
- Render Free for the existing Node/Express API.
- A new, separate Neon Free production database.
- A dedicated Clerk Production instance.

Do not use employee roster data from the hospital in this pilot. Use synthetic
staff records only. Render describes Free services as unsuitable for production
applications; this setup is therefore a limited pilot, not a production
availability commitment.

## Repository deployment files

- `render.yaml` defines the Node web service, build/start commands, health path,
  free plan, and required Render environment-variable names. Secret values are
  intentionally not stored in the repository.
- `wrangler.toml` identifies the Cloudflare Pages static output directory.
- `scripts/build-cloudflare-pages.sh` validates the public build settings,
  installs the workspace dependencies, and builds the PWA.
- `functions/api/__clerk/[[path]].ts` forwards only Clerk Frontend API proxy
  requests from the app's own domain to the Render API. This is needed because
  Clerk requires its Frontend API proxy to be on the same domain as the app.

## 1. Create isolated services

1. Connect this repository to Cloudflare Pages and Render. Do not connect
   Replit's Development or Production databases to either host.
2. Create a **new Neon project/database for the pilot**. Do not reuse the
   Development, Staging, or any existing Production database.
3. Create a separate Clerk Production instance. Clerk's current production
   setup requires a domain you own and DNS access. A `pages.dev` URL alone is
   not a substitute for that prerequisite.
4. Configure the owned application domain on Cloudflare Pages and follow
   Clerk's domain/DNS instructions. Configure OAuth credentials in Clerk for
   each sign-in provider the pilot will expose.
5. Choose one pilot Admin and set that address only in the Render
   `AMAN_ADMIN_EMAILS` environment variable. Add a Staff test account
   separately in Clerk. Never copy the Development or Staging allowlist
   automatically.

## 2. Initialize the new Neon database safely

The database package currently has a Drizzle schema push command, but no
versioned SQL migration directory. The API startup does not create the complete
schema; it only ensures the supported departments and shift definitions.

1. Save the new Neon connection string as a **local secret**
   `AMAN_PILOT_DATABASE_URL`. Do not put it in `.env`, source files, shell
   history, or `render.yaml`.
2. Verify the target before any schema command. Use the Neon console or an
   approved PostgreSQL client to check the database name, host, and that it has
   no application tables or employee rows. Do not print the connection string.
   A PostgreSQL client can check the identity and public-table count with:

   ```bash
   psql "$AMAN_PILOT_DATABASE_URL" -XAtc \
     "select current_database(), current_user, count(*) from pg_catalog.pg_tables where schemaname = 'public' group by current_database(), current_user"
   ```

   An empty database may return no table-count row. Never paste command output
   containing connection details into chat or commit it.
3. Confirm the new database is empty and reserved for this pilot. If it is not
   empty or its identity is unclear, stop and create another empty database.
4. Review the current schema against a disposable database first. Then, only
   after explicit approval, apply the schema to the new pilot database with:

   ```bash
   DATABASE_URL="$AMAN_PILOT_DATABASE_URL" pnpm --filter @workspace/db run push
   ```

   This command targets only the value assigned in that shell invocation. Do
   not source Development or Staging `.env` files in the same shell.
5. Verify tables and indexes are present, and confirm no employee or roster
   records were imported. The API startup may add department and shift
   definition lookup rows; it does not import an Excel workbook.
6. Keep the pilot connection string in Render's secret environment variable
   `DATABASE_URL`; it must point to this new pilot database only.

No schema command was run while preparing this configuration.

## 3. Deploy the API on Render

Create a Web Service from the repository root using the checked-in
`render.yaml` Blueprint, or copy these values into Render:

- Runtime: Node.
- Plan: Free.
- Build: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`
- Start: `pnpm --filter @workspace/api-server run start`
- Health check: `/api/healthz`
- Automatic deploys: disabled in the Blueprint; deploy manually after review.

The API reads `process.env.PORT`, validates it, and calls `app.listen(port)`.
Node's default listener binds to the unspecified interface on Linux, so the
Render-provided port is used and the service is reachable through Render's
proxy. The health endpoint is public and returns only `{ "status": "ok" }`.

Set these Render environment values:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24.22.3` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | New pilot Neon pooled TLS connection string; secret |
| `CLERK_PUBLISHABLE_KEY` | Clerk Production publishable key |
| `CLERK_SECRET_KEY` | Clerk Production secret key; secret |
| `AMAN_ADMIN_EMAILS` | Pilot Admin allowlist, entered separately from Development |
| `AMAN_ALLOWED_ORIGINS` | Exact HTTPS Pages/custom application origin(s), comma-separated |

Render supplies `PORT`; do not hardcode it. Never add `STAGING_DATABASE_URL` or
the Development database URL to this service.

## 4. Build and host the PWA on Cloudflare Pages

Configure the Pages project with:

- Root directory: repository root.
- Build command: `bash scripts/build-cloudflare-pages.sh`
- Build output directory: `artifacts/aman-team-shifts/dist/public`
- Production environment variables:
  - `VITE_API_ORIGIN`: HTTPS origin of the Render API, with no path.
  - `VITE_CLERK_PUBLISHABLE_KEY`: Clerk Production publishable key.
  - `VITE_CLERK_PROXY_URL`: `https://<app-domain>/api/__clerk`

The build script sets `BASE_PATH=/` and a build-time `PORT` fallback because
the Vite config validates both values. The Cloudflare Pages Function also needs
the runtime variable `RENDER_API_ORIGIN`, set to the Render API HTTPS origin
with no path. It is not a credential.

Never place `CLERK_SECRET_KEY`, `DATABASE_URL`, or any other private key in a
`VITE_*` variable. Vite embeds `VITE_*` values into publicly downloadable
frontend assets.

## 5. Clerk and cross-domain checks

Clerk's production documentation requires an owned domain and DNS setup. The
proxy endpoint must share the app's public domain; the Pages Function above
forwards `/api/__clerk/*` to Render while preserving the public app host for
Clerk's `Clerk-Proxy-Url`. Normal roster API calls still go directly to Render
and are protected by the existing HTTPS CORS allowlist plus the Clerk bearer
token.

Before inviting pilot users, test all of these on the actual Pages custom
domain:

1. Clerk Production publishable/secret keys are paired and never mixed with
   Development keys.
2. Google/Microsoft or other selected production sign-in providers complete
   their OAuth redirect and return to the app.
3. Clerk requests use the same app-domain `/api/__clerk` proxy and do not
   redirect to an unintended host.
4. The Render API's `AMAN_ALLOWED_ORIGINS` matches the exact HTTPS app origin.
5. Anonymous API reads return 401 except `/api/healthz`; Staff writes return
   403; Admin writes succeed.
6. The PWA service worker caches only app-shell assets. Authenticated API
   responses remain `no-store` and are not shown as current while offline.

The cross-domain Clerk flow has not yet been executed against real hosted
services or production Clerk credentials.

## 6. PWA and pilot acceptance

After both services are deployed:

- Verify `/manifest.webmanifest`, both PWA icons, and `/service-worker.js`
  return successfully over HTTPS.
- Install from Chrome on Android and verify standalone launch.
- Confirm all roster API calls use HTTPS and update from a second authenticated
  session within the 45-second foreground polling interval.
- Verify the offline state is clear and no roster data appears as current while
  offline.
- Keep the pilot roster synthetic; do not upload the hospital workbook.

Cloudflare Pages supplies HTTPS on its hosted domain, and Render supplies
HTTPS on its service domain. Clerk production still needs the owned application
domain and provider setup above.

## 7. Backup and restore procedure

Neon Free currently has a limited point-in-time restore window and does not
include scheduled backups. Before any pilot data is considered valuable:

1. Create a private backup directory outside the repository and set a
   restrictive umask. Keep `AMAN_PILOT_DATABASE_URL` in a secret environment
   variable, not in the command text:

   ```bash
   umask 077
   mkdir -p "$BACKUP_DIR"
   set -o pipefail
   pg_dump --format=custom --no-owner --no-acl "$AMAN_PILOT_DATABASE_URL" \
     | gpg --symmetric --cipher-algo AES256 \
       --output "$BACKUP_DIR/aman-pilot-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
   ```

   GPG prompts for the encryption passphrase; do not put it in shell history,
   process arguments, or a repository file. Store the encrypted dump in
   approved storage outside Neon and Git.
2. Record the schema revision and dump timestamp without recording credentials.
3. Create a separate empty restore database and verify its database identity
   before restoring. Keep its connection string in
   `AMAN_RESTORE_DATABASE_URL`.
4. Restore only to that disposable database:

   ```bash
   gpg --decrypt "$BACKUP_FILE" \
     | pg_restore --no-owner --no-acl --exit-on-error \
       --dbname="$AMAN_RESTORE_DATABASE_URL"
   ```

5. Run the application read checks and confirm employee, roster version,
   assignment, and audit counts match the dump.
6. Document who can initiate restore and keep the restore database isolated
   until verification passes.

Do not restore or migrate Development, Staging, or another Production database
as part of this pilot.

## Free-tier constraints

- Render Free may sleep after inactivity and has limited CPU/RAM and monthly
  free service hours. Render warns against using Free services for production.
- Cloudflare Workers/Pages Function quotas apply to requests sent to the Clerk
  proxy function. The main roster API remains on Render.
- Neon Free has bounded compute, storage, transfer, and restore history.
- Clerk Free includes a bounded monthly retained-user allowance and may require
  additional production domain/OAuth setup.
- A custom domain may have a registrar fee; do not purchase one automatically.
