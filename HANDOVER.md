# Linux Server Control handover

## Purpose

Linux Server Control is a private-network dashboard for administering Docker containers, approved shell scripts, cron schedules, files, and authorized browser devices over SSH.

The application uses Next.js with TypeScript, the App Router, and Docker Compose. Persistent dashboard data is stored in the `DATA_DIR` volume.

## Main files

- `src/app/page.tsx` contains the dashboard shell and view composition.
- `src/components/` contains the client components by area: `ui`, `containers`, `scripts`, `files`, `schedules`, `settings`, `monitoring`, and `auth`.
- `src/lib/types.ts` contains the client-side data types.
- `src/lib/client-api.ts` contains the client API helper and structured API errors.
- `src/app/globals.css` contains the responsive dashboard styles.
- `src/app/api/[...path]/route.ts` checks the request origin, authenticates, and dispatches to the route tables.
- `src/lib/api/` implements the API: `auth.ts` (setup, sign-in, rate limiting, sessions, devices), `routes.ts` (all signed-in routes, keyed by method and path), `http.ts` (responses and cookies), and `demo.ts` (development demo data).
- `src/lib/server.ts` implements SSH, Docker, file, script, cron, metric, alert, and system-statistics helpers, plus the validation shared by forms and configuration restore.
- `src/instrumentation.ts` starts the background monitor and recovers interrupted runs when the server starts.
- `compose.yaml` builds and exposes the dashboard directly on the configured LAN IP.
- `compose.github.yaml` is a standalone Compose file that pulls the multi-architecture dashboard image from GHCR.
- `.github/workflows/container.yml` publishes `latest`, semantic-version, and commit tags for `amd64` and `arm64`.
- `.env.example` documents the required environment settings.

## Setup and deployment

There are two supported application deployment paths:

- `compose.yaml` builds the current source checkout locally.
- `compose.github.yaml` pulls `ghcr.io/florincamarut1/linux-server-control:${VERSION:-latest}` from GHCR and does not require a repository clone.

Both Compose files load runtime settings with `env_file: .env`; `DATA_DIR` is overridden inside the container as `/app/data`. The dashboard is served over plain HTTP on `${LAN_IP}:8443`, without a proxy or local certificate.

For a source checkout, copy `.env.example` to `.env`, configure the SSH target and private-network settings, then build and start the services:

```bash
docker compose build dashboard
docker compose up -d dashboard
docker compose ps
```

Run `npm run build` before deploying source changes. Keep `.env`, SSH keys, dashboard data, enrollment codes, and passwords outside Git.

For a no-clone deployment, download `compose.github.yaml` as `compose.yaml`, copy `.env.example`, create the `data` and `ssh` directories, then run `docker compose up -d`. `pull_policy: always` checks the selected image tag whenever Compose starts the service. `latest` follows successful builds from `main`; `VERSION` can pin another published tag. The administrator must still deliberately configure the SSH target, allowed paths, key, and host fingerprint.

## First-run application setup

An empty `DATA_DIR` no longer requires `scripts/setup.mjs`. The client checks `GET /api/setup/status`; when no password configuration exists, the API generates a one-time bootstrap token in `setup-bootstrap.json` and prints it to the dashboard container logs. The browser then displays the setup form.

`POST /api/setup` requires that token, a valid username, and matching passwords of at least 12 characters. The setup page also confirms the SSH target before completing; it uses the mounted private key and `known_hosts` file, never stores SSH credentials in dashboard data. On success it:

- stores the scrypt password hash and salt in `config.json`;
- consumes the bootstrap token;
- registers the current browser as the first authorized device;
- creates the initial session plus HTTP-only, SameSite-strict cookies.

The initial `.env` remains the portable installation default. After setup, **Settings → Server connection** can update the SSH target, script root, allowed paths, and remote log folder in `server-settings.json`, then verifies the connection with `hostname`. These values are non-secret and are included in a dashboard-settings export; SSH keys and fingerprints remain external mounts.

After `config.json` contains a password, the setup endpoint refuses further initialization attempts. Additional browsers use the existing time-limited enrollment flow. `scripts/setup.mjs` remains available for legacy or non-browser provisioning but is not part of the normal installation path.

## Image publication

`.github/workflows/container.yml` runs for pushes to `main`, version tags, and pull requests. Pull requests build without publishing. Pushes publish OCI images to GHCR for `linux/amd64` and `linux/arm64`, with BuildKit caching and provenance attestations. The generated tags include `latest` for `main`, semantic-version variants for `v*` tags, and a commit tag.

## Access control

- Login uses a dashboard username and password.
- New browsers require a time-limited enrollment code.
- Sessions use HTTP-only, SameSite-strict cookies. Set `COOKIE_SECURE=true` only when an external HTTPS reverse proxy is added.
- Cookie names are `lsc_session` and `lsc_device`. They intentionally differ from the earlier HTTPS-only `session` and `device` cookies, because browsers do not allow a plain-HTTP response to overwrite an existing Secure cookie with the same name.
- POST requests validate their origin.
- Failed sign-ins are rate-limited per enrolled browser (5 failures) and, for all unknown browsers together, in one shared bucket (10 failures); each block lasts 15 minutes. Client addresses are not used because clients can forge `X-Forwarded-For` when there is no proxy. Guessing from new browsers therefore cannot lock out an enrolled browser.
- A new browser must present a valid enrollment code before its password is checked, so it cannot learn whether a guessed password is correct.
- `GET /api/setup/status` returns the server connection details only until setup is complete.
- Keep the HTTP port on a trusted private LAN; do not expose the dashboard directly to the public internet.

## Overview and system statistics

The Overview page is the default landing screen: it summarizes running/stopped containers, CPU/RAM/disk health, and the latest failed script or scheduled run with a direct log action. The Containers page refreshes every 15 seconds and shows CPU temperature, current CPU utilization, RAM use, system-disk capacity, configured storage mounts, uptime, and container counts.

`MONITORED_PATHS` provides the initial comma-separated list of filesystem paths. After first startup, **Settings → Storage monitoring** (also available on Containers) persists additions and removals in `DATA_DIR`, without an `.env` edit. The cards are paginated four at a time. Metric retention can likewise be changed in **Settings → Server connection**; the `.env` value is the initial default. For example:

```env
MONITORED_PATHS=/srv/media,/srv/backups
```

Invalid or unavailable paths display `Unavailable` without preventing other dashboard statistics from loading.

A background monitor, started from `src/instrumentation.ts`, records one health sample every 5 minutes, evaluates alert rules, and collects cron runs, even while no browser is open. Dashboard polls never add extra samples, so the configured retention is what limits the history. `/api/state` returns only the latest sample and the sample count; `/api/history/metrics` returns the full history.

## Containers

The Containers page lists active and stopped containers from `docker ps -a`. It supports filtering, details, logs, start, stop, and restart actions. Container sizes are expensive for Docker to compute, so refreshes skip them and `POST /api/container/size` reads one when its details are opened.

## Files and scripts

`ALLOWED_PATHS` is a comma-separated list of roots available to the file and script browsers. Choose these carefully: every authorized dashboard user can browse and modify files readable by the configured SSH account under these roots.

The Files page supports an absolute-path bar, list and grid views, search, name/size sorting, pagination, folder-size display, text-file editing up to 512 KB, and create, copy, move, rename, and delete actions. Folder sizes are fetched asynchronously and size sorting is applied after that scan completes. File and folder actions remain server-side validated against `ALLOWED_PATHS`.

Scripts must be registered before they can run. Script records may be grouped, assigned run options, and scheduled; each script row shows whether it is scheduled and its latest run status, and opens its schedule form directly. Deleting a script removes its dashboard record and managed schedules but does not delete the script file.

Root execution and root cron management require the controlled helpers in `scripts/`. Install them only after reviewing their allowed paths and sudoers configuration.

## Root security model

The dashboard connects over SSH as an unprivileged account. It does not receive general passwordless `sudo`; the sudoers entries allow only `/usr/local/sbin/media-dashboard-root-run` and `/usr/local/sbin/media-dashboard-root-cron` with their supported operations.

For an immediate root script run, the helper requires an absolute `.sh` path, rejects a requested symlink, resolves the real path, verifies that the target is a regular file, and permits it only when it is below a root listed in `/etc/media-dashboard/root-script-paths`. Application commands and script arguments are passed as argument arrays instead of being interpolated into an interactive shell command.

The approved root-script directories form a security boundary. They should be owned by `root` and must not be writable by the dashboard SSH account. If that account can edit an approved script, an authenticated dashboard user can change the script and execute arbitrary code as root. A suitable baseline is:

```bash
sudo chown -R root:root /srv/dashboard-root-scripts
sudo chmod 755 /srv/dashboard-root-scripts
sudo chmod 755 /srv/dashboard-root-scripts/*.sh
```

Adjust the example path to the configured directory and confirm permissions on every parent directory. Do not include an editable Files root inside a writable root-script directory.

Root cron access has a wider trust boundary. The helper can replace root's crontab. Custom commands are permitted only for the normal SSH user; root schedules are restricted by the application to approved scripts. Treat access to this dashboard as administrative access, keep it behind a private LAN or VPN, and enable root cron only where this behavior is intended.

## Schedules and logs

Scheduled jobs use guided cron forms and managed comments so the dashboard changes only its own entries. Every `%` in a managed line is escaped, because cron would otherwise treat it as a newline. Crontab updates run one at a time and always install the latest saved schedules. Only a missing crontab (`no crontab for USER`, or BusyBox's `can't open`) is treated as empty; any other read failure aborts the update instead of replacing the user's own entries. The latest 20 crontab backups per user are kept in `DATA_DIR`. Managed schedules emit start/end markers to the remote `schedules.log`; the History page presents a searchable, status-filtered, paginated cron-run view. Manual script runs persist start/end time, exit code, duration, arguments, status, and a per-run captured log. The newest 2,000 runs are kept, and the logs of older runs are deleted. Runs still marked as running when the server starts are marked failed with an interruption note, because the restart ended their SSH session. Container and script log viewers can refresh automatically while live mode is enabled.

## Operational notes

- The standard deployment is available at `http://${LAN_IP}:8443`. Port `8443` is retained to avoid collisions with common media-server services even though the protocol is now HTTP.
- After migration from the former HTTPS deployment, each browser must enroll once under HTTP. The legacy Secure cookies are ignored; account credentials, devices, scripts, schedules, and history remain in `DATA_DIR` and are not reset.
- Periodic host snapshots use asynchronous SSH reads in parallel. Concurrent snapshot requests share in-flight work; completed snapshots are not cached. The snapshot also reads the schedule log, so a refresh needs no separate cron read.
- CPU usage is the difference between the CPU counters of consecutive refreshes. Only the first refresh, or one more than 10 minutes after the previous, samples on the host with a 150 ms pause. On the reference server this reduced a refresh from about 220 ms to about 60 ms.
- The root helpers' availability and root's crontabs are cached for 5 minutes, and refreshed after the dashboard installs root's crontab.
- `GET /api/state` reads the host. `?scope=records` returns only the records stored in `DATA_DIR` without SSH, and `?scope=history` adds the cron runs. The client uses the full state on Overview, Containers, and Schedules, the history scope on History, and the records scope on the other pages; partial responses are merged into the loaded state.
- Files loads directory entries first and requests recursive folder sizes separately. Script and file pickers do not calculate recursive sizes. Size failures do not prevent navigation.
- Automatic dashboard polling pauses while the browser tab is hidden and refreshes when it becomes visible. Scheduled polls do not overlap one another.
- Run the tests with `npm test`. `tests/harness.mjs` loads `server.ts` against a temporary data directory with scripted host responses.
- Host commands run asynchronously over one multiplexed SSH connection (`SSH_MULTIPLEX=false` disables multiplexing). A failed command surfaces as `CommandError` with only the last stderr line; the command line is never returned to the browser.
- Configuration restores are validated with the same rules as the regular forms, and nothing is written unless every record is valid.
- Keep the API catch-all route at `src/app/api/[...path]/route.ts`.
- The dashboard uses SSH for all host operations; it does not mount the host Docker socket.
- File listing calculates directory sizes with a bounded command. Restricted directories can have an unavailable or partial size.
- The file menu provides Edit, Copy, Cut, Rename, and Delete actions without crowding each row.
- All destructive confirmations and name-entry prompts use application modals instead of browser-native dialogs.
- The History page has separate Script runs and Cron runs tabs, each with search, status filtering, and 20-row pagination.
- Dashboard metric samples and alert rules are stored in `DATA_DIR`; metric retention defaults to 30 days and is configurable with `METRICS_RETENTION_DAYS`. The failed-scripts alert counts failures from the last 24 hours.
- README screenshots under `docs/screenshots/` use anonymized demonstration data only.
- The interface is responsive for phone screens.

## Known limitations

- Folder sizes require a recursive `du` scan. Entries appear first, but size calculation can remain expensive on very large directory trees.
- The Files API returns at most 300 entries per directory; pagination applies within that bounded result set rather than to arbitrarily large remote directories.
- Alerts are evaluated by the background monitor and during dashboard refreshes, and written to the audit log. They do not yet send email, push, or chat notifications.
- Metric history currently appears as latest-value cards and counts; compact time-series charts have not been added yet.
- The automated tests cover snapshot concurrency, cron synchronization and escaping, configuration restore validation, schedule and alert rules, metric sampling, and run recovery. Authentication, file operations, and responsive UI flows still need integration coverage.
- Root schedules run the approved script directly from root's crontab, not through `media-dashboard-root-run`, so the root-script directory allowlist does not apply to them. Only scripts registered in the dashboard can be scheduled as root.
- The dashboard distinguishes a lost SSH connection from a login failure and displays a reconnect screen. Settings can be edited after connectivity returns; the reconnect screen intentionally avoids presenting a configuration form while the server cannot be verified.

## Recommended next work

1. Add actual notification delivery for alert rules (email, webhook, or a user-selected provider), while retaining the existing cooldown behavior.
2. Add compact CPU, RAM, temperature, and disk time-series charts with configurable aggregation and retention.
3. Add roles such as administrator and read-only operator if the dashboard will be shared by multiple people.
4. Expand integration tests around authentication, allowed-path enforcement, file operations, and mobile layouts.
5. Route root schedules through `media-dashboard-root-run`, so they are restricted to the approved root-script directories like immediate root runs.
6. Add true remote-directory pagination beyond the current 300-entry safety cap.
