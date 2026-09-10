# Linux Server Control

A private dashboard for one Linux server: Docker containers, approved scripts, schedules, files, storage, and browser access—all from a browser.

It is intended for people comfortable administering their own server. It runs entirely in Docker and controls the host through a dedicated SSH key; it does not mount the Docker socket.

## What it does

- See, start, stop, restart, and inspect Docker containers.
- Run approved shell scripts and follow the exact run log live.
- Create and manage guided cron schedules.
- Browse and edit files only inside paths you explicitly allow.
- See storage, CPU, RAM, disk, and execution history.
- Manage browser devices, password, server connection, storage paths, and dashboard-settings exports from **Settings**.

## Install

The installation is deliberately split into two parts:

1. **[Install Docker](INSTALL.md#1-install-docker)** — only needed once on a new server.
2. **[Install Linux Server Control](INSTALL.md#2-install-linux-server-control)** — download, configure, and start the dashboard.

The normal installation uses the ready-made multi-architecture image from GitHub Container Registry. No Git clone and no local Node.js setup are needed.

```bash
mkdir -p ~/linux-server-control/{data,ssh}
cd ~/linux-server-control
curl -fsSLo compose.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.github.yaml
curl -fsSLo .env https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/.env.example
```

Then continue at [Configure the dashboard](INSTALL.md#3-configure-the-dashboard).

## Update

```bash
cd ~/linux-server-control
docker compose pull
docker compose up -d
```

`latest` is checked every time Compose starts the dashboard. Use `VERSION` in `.env` if you want to pin a published image tag.

## Security

- Keep it on a trusted LAN or another private network. Do not expose port `8080` to the public internet.
- Use a dedicated SSH key and verify the server fingerprint in `ssh/known_hosts`.
- Keep `ALLOWED_PATHS` narrow. Anyone authorized in the dashboard can edit files in these folders and control Docker, which is effectively administrative access to the host.
- Back up `.env`, `data/`, and `ssh/` privately. Never commit them.

## Development

```bash
npm ci
npm run dev
npm run build
```

## License

[MIT](LICENSE)
