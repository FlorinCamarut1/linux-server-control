# Linux Server Control handover

## Purpose

Linux Server Control is a private-network dashboard for administering Docker containers, approved shell scripts, cron schedules, files, and authorized browser devices over SSH.

The application uses Next.js with TypeScript, the App Router, Docker Compose, and Caddy. Persistent dashboard data is stored in the `DATA_DIR` volume.

## Main files

- `src/app/page.tsx` contains the client dashboard UI and view composition.
- `src/lib/client-api.ts` contains the client API helper and structured API errors.
- `src/app/globals.css` contains the responsive dashboard styles.
- `src/app/api/[...path]/route.ts` implements authenticated API routes.
- `src/lib/server.ts` implements SSH, Docker, file, script, cron, and system-statistics helpers.
- `compose.yaml` defines the dashboard and reverse proxy services.
- `compose.github.yaml` is a standalone Compose file that pulls the multi-architecture dashboard image from GHCR.
- `.github/workflows/container.yml` publishes `latest`, semantic-version, and commit tags for `amd64` and `arm64`.
- `.env.example` documents the required environment settings.

## Setup and deployment

There are two supported application deployment paths:

- `compose.yaml` builds the current source checkout locally.
- `compose.github.yaml` pulls `ghcr.io/florincamarut1/linux-server-control:${VERSION:-latest}` from GHCR and does not require a repository clone.

Both Compose files load runtime settings with `env_file: .env`; `DATA_DIR` is overridden inside the container as `/app/data`. This ensures settings such as `SSH_TARGET`, `ALLOWED_PATHS`, `MONITORED_PATHS`, and `METRICS_RETENTION_DAYS` are passed to the application without being repeated in Compose.

For a source checkout, copy `.env.example` to `.env`, configure the SSH target and private-network settings, then build and start the services:

```bash
docker compose build dashboard
docker compose up -d dashboard
docker compose ps
```

Run `npm run build` before deploying source changes. Keep `.env`, SSH keys, dashboard data, enrollment codes, and passwords outside Git.

For a no-clone deployment, download `compose.github.yaml` as `compose.yaml`, copy `.env.example`, create the `data` and `ssh` directories, then run `docker compose up -d`. `pull_policy: always` checks the selected image tag whenever Compose starts the service. `latest` follows successful builds from `main`; `VERSION` can pin another published tag. The administrator must still deliberately configure the SSH target, allowed paths, key, host fingerprint, and LAN certificate; these values cannot be safely inferred.

## First-run application setup

An empty `DATA_DIR` no longer requires `scripts/setup.mjs`. The client checks `GET /api/setup/status`; when no password configuration exists, the API generates a one-time bootstrap token in `setup-bootstrap.json` and prints it to the dashboard container logs. The browser then displays the setup form.

`POST /api/setup` requires that token, a valid username, and matching passwords of at least 12 characters. The setup page also confirms the SSH target before completing; it uses the mounted private key and `known_hosts` file, never stores SSH credentials in dashboard data. On success it:

- stores the scrypt password hash and salt in `config.json`;
- consumes the bootstrap token;
- registers the current browser as the first authorized device;
- creates the initial session and secure cookies.

The initial `.env` remains the portable installation default. After setup, **Settings → Server connection** can update the SSH target, script root, allowed paths, and remote log folder in `server-settings.json`, then verifies the connection with `hostname`. These values are non-secret and are included in a dashboard-settings export; SSH keys and fingerprints remain external mounts.

After `config.json` contains a password, the setup endpoint refuses further initialization attempts. Additional browsers use the existing time-limited enrollment flow. `scripts/setup.mjs` remains available for legacy or non-browser provisioning but is not part of the normal installation path.

## Image publication

`.github/workflows/container.yml` runs for pushes to `main`, version tags, and pull requests. Pull requests build without publishing. Pushes publish OCI images to GHCR for `linux/amd64` and `linux/arm64`, with BuildKit caching and provenance attestations. The generated tags include `latest` for `main`, semantic-version variants for `v*` tags, and a commit tag.

## Access control

- Login uses a dashboard username and password.
- New browsers require a time-limited enrollment code.
- Sessions are secure, HTTP-only cookies.
- POST requests validate their origin.
- Five failed sign-ins from one source address result in a temporary block.
- Deploy behind a private LAN, VPN, or equivalent access boundary; do not expose the dashboard directly to the public internet.

## Overview and system statistics

The Overview page is the default landing screen: it summarizes running/stopped containers, CPU/RAM/disk health, and the latest failed script or scheduled run with a direct log action. The Containers page refreshes every 15 seconds and shows CPU temperature, current CPU utilization, RAM use, system-disk capacity, configured storage mounts, uptime, and container counts.

`MONITORED_PATHS` provides the initial comma-separated list of filesystem paths. After first startup, **Settings → Storage monitoring** (also available on Containers) persists additions and removals in `DATA_DIR`, without an `.env` edit. The cards are paginated four at a time. Metric retention can likewise be changed in **Settings → Server connection**; the `.env` value is the initial default. For example:

```env
MONITORED_PATHS=/srv/media,/srv/backups
```

Invalid or unavailable paths display `Unavailable` without preventing other dashboard statistics from loading.

## Containers

The Containers page lists active and stopped containers from `docker ps -a`. It supports filtering, details, logs, start, stop, and restart actions.

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

Scheduled jobs use guided cron forms and managed comments so the dashboard changes only its own entries. Managed schedules emit start/end markers to the remote `schedules.log`; the History page presents a searchable, status-filtered, paginated cron-run view. Manual script runs persist start/end time, exit code, duration, arguments, status, and a per-run captured log. Container and script log viewers can refresh automatically while live mode is enabled.

## Operational notes

- Periodic host snapshots use asynchronous SSH reads in parallel. Concurrent snapshot requests share in-flight work; completed snapshots are not cached.
- Files loads directory entries first and requests recursive folder sizes separately. Script and file pickers do not calculate recursive sizes. Size failures do not prevent navigation.
- Automatic dashboard polling pauses while the browser tab is hidden and refreshes when it becomes visible. Scheduled polls do not overlap one another.
- Run the concurrency regression checks with `node --test tests/performance.test.mjs`.
- Keep the API catch-all route at `src/app/api/[...path]/route.ts`.
- The dashboard uses SSH for all host operations; it does not mount the host Docker socket.
- File listing calculates directory sizes with a bounded command. Restricted directories can have an unavailable or partial size.
- The file menu provides Edit, Copy, Cut, Rename, and Delete actions without crowding each row.
- All destructive confirmations and name-entry prompts use application modals instead of browser-native dialogs.
- The History page has separate Script runs and Cron runs tabs, each with search, status filtering, and 20-row pagination.
- Dashboard metric samples and alert rules are stored in `DATA_DIR`; metric retention defaults to 30 days and is configurable with `METRICS_RETENTION_DAYS`.
- README screenshots under `docs/screenshots/` use anonymized demonstration data only.
- The interface is responsive for phone screens.

## Known limitations

- Folder sizes require a recursive `du` scan. Entries appear first, but size calculation can remain expensive on very large directory trees.
- The Files API returns at most 300 entries per directory; pagination applies within that bounded result set rather than to arbitrarily large remote directories.
- Alerts are evaluated during dashboard snapshot refreshes and written to the audit log. They do not yet send email, push, or chat notifications.
- Metric history currently appears as latest-value cards and counts; compact time-series charts have not been added yet.
- The automated tests cover snapshot concurrency and failure recovery. Authentication, file operations, cron synchronization, and responsive UI flows still need integration coverage.
- The dashboard distinguishes a lost SSH connection from a login failure and displays a reconnect screen. Settings can be edited after connectivity returns; the reconnect screen intentionally avoids presenting a configuration form while the server cannot be verified.

## Recommended next work

1. Add actual notification delivery for alert rules (email, webhook, or a user-selected provider), while retaining the existing cooldown behavior.
2. Add compact CPU, RAM, temperature, and disk time-series charts with configurable aggregation and retention.
3. Add roles such as administrator and read-only operator if the dashboard will be shared by multiple people.
4. Expand integration tests around authentication, allowed-path enforcement, file operations, cron changes, history capture, and mobile layouts.
5. Consider SSH connection multiplexing when deployments use many independent SSH requests and the target supports persistent control sockets.
6. Add true remote-directory pagination beyond the current 300-entry safety cap.
