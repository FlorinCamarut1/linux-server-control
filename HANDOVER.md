# Linux Server Control handover

## Purpose

Linux Server Control is a private-network dashboard for administering Docker containers, approved shell scripts, cron schedules, files, and authorized browser devices over SSH.

The application uses Next.js with TypeScript, the App Router, Docker Compose, and Caddy. Persistent dashboard data is stored in the `DATA_DIR` volume.

## Main files

- `src/app/page.tsx` contains the client dashboard UI.
- `src/app/globals.css` contains the responsive dashboard styles.
- `src/app/api/[...path]/route.ts` implements authenticated API routes.
- `src/lib/server.ts` implements SSH, Docker, file, script, cron, and system-statistics helpers.
- `compose.yaml` defines the dashboard and reverse proxy services.
- `.env.example` documents the required environment settings.

## Setup and deployment

Copy `.env.example` to `.env`, configure the SSH target and private-network settings, then build and start the service:

```bash
docker compose build dashboard
docker compose up -d dashboard
docker compose ps
```

Run `npm run build` before deploying source changes. Keep `.env`, SSH keys, dashboard data, enrollment codes, and passwords outside Git.

## Access control

- Login uses a dashboard username and password.
- New browsers require a time-limited enrollment code.
- Sessions are secure, HTTP-only cookies.
- POST requests validate their origin.
- Five failed sign-ins from one source address result in a temporary block.
- Deploy behind a private LAN, VPN, or equivalent access boundary; do not expose the dashboard directly to the public internet.

## System statistics

The Containers page refreshes every 15 seconds and shows CPU temperature, current CPU utilization, RAM use, system-disk capacity, configured storage mounts, uptime, and container counts.

`MONITORED_PATHS` accepts a comma-separated list of filesystem paths. The dashboard creates one storage card per path. For example:

```env
MONITORED_PATHS=/srv/media,/srv/backups
```

Invalid or unavailable paths display `Unavailable` without preventing other dashboard statistics from loading.

## Containers

The Containers page lists active and stopped containers from `docker ps -a`. It supports filtering, details, logs, start, stop, and restart actions.

## Files and scripts

`ALLOWED_PATHS` is a comma-separated list of roots available to the file and script browsers. Choose these carefully: every authorized dashboard user can browse and modify files readable by the configured SSH account under these roots.

The Files page supports an absolute-path bar, list and grid views, folder-size display, text-file editing up to 512 KB, and copy, move, rename, and delete actions. File and folder actions remain server-side validated against `ALLOWED_PATHS`.

Scripts must be registered before they can run. Script records may be grouped, assigned run options, and scheduled. Deleting a script removes its dashboard record and managed schedules but does not delete the script file.

Root execution and root cron management require the controlled helpers in `scripts/`. Install them only after reviewing their allowed paths and sudoers configuration.

## Schedules and logs

Scheduled jobs use guided cron forms and managed comments so the dashboard changes only its own entries. Container and script log viewers can refresh automatically while live mode is enabled.

## Operational notes

- Keep the API catch-all route at `src/app/api/[...path]/route.ts`.
- The dashboard uses SSH for all host operations; it does not mount the host Docker socket.
- File listing calculates directory sizes with a bounded command. Restricted directories can have an unavailable or partial size.
- The file menu provides Edit, Copy, Cut, Rename, and Delete actions without crowding each row.
- The interface is responsive for phone screens.

## Suggested next work

- Add per-script execution history with exit code and completion time.
- Add role separation for multiple administrators.
- Add export and restore for dashboard configuration.
- Add configurable alert thresholds for system statistics.
