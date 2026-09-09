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

- Periodic host snapshots use asynchronous SSH reads in parallel. Concurrent snapshot requests share in-flight work; completed snapshots are not cached.
- Files loads directory entries first and requests recursive folder sizes separately. Script and file pickers do not calculate recursive sizes. Size failures do not prevent navigation.
- Automatic dashboard polling pauses while the browser tab is hidden and refreshes when it becomes visible. Scheduled polls do not overlap one another.
- Run the concurrency regression checks with `node --test tests/performance.test.mjs`.
- Keep the API catch-all route at `src/app/api/[...path]/route.ts`.
- The dashboard uses SSH for all host operations; it does not mount the host Docker socket.
- File listing calculates directory sizes with a bounded command. Restricted directories can have an unavailable or partial size.
- The file menu provides Edit, Copy, Cut, Rename, and Delete actions without crowding each row.
- The interface is responsive for phone screens.

## Known limitations

- Sessions are held in application memory, so restarting the dashboard signs users out.
- Folder sizes require a recursive `du` scan. Entries appear first, but size calculation can remain expensive on very large directory trees.
- The Files API returns at most 300 entries per directory and has no search, sort controls, or pagination.
- Script runs do not yet persist structured completion status, exit code, duration, or historical records.
- System statistics are current snapshots; no historical samples or alert thresholds are stored.
- The automated tests cover snapshot concurrency and failure recovery. Authentication, file operations, cron synchronization, and responsive UI flows still need integration coverage.

## Recommended next work

1. Add script execution history with start time, completion time, exit code, duration, arguments, and a link to the captured log.
2. Add configurable alerts for temperature, CPU, RAM, low disk space, failed scripts, and stopped containers. Include notification cooldowns to avoid repeated alerts.
3. Persist sessions or use signed, revocable session tokens so a normal deployment does not sign every browser out.
4. Add export and restore for configuration, scripts, folders, schedules, devices, and alert rules without exporting credentials.
5. Add search, sorting, pagination, and optional size calculation in Files for directories containing many entries.
6. Store time-series samples for CPU, RAM, temperatures, and disks, then add compact history charts and configurable retention.
7. Add roles such as administrator and read-only operator if the dashboard will be shared by multiple people.
8. Expand integration tests around authentication, allowed-path enforcement, file operations, cron changes, and mobile layouts.
9. Consider SSH connection multiplexing when deployments use many independent SSH requests and the target supports persistent control sockets.
