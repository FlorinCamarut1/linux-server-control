# Linux Server Control

Linux Server Control is a self-hosted dashboard for administering one Linux server from a browser. It is built with Next.js and TypeScript and runs as Docker containers.

## Features

- View running and stopped Docker containers
- Start, stop, restart, and inspect container logs
- Register shell scripts and organize them into folders
- Create executable custom shell scripts inside approved directories
- Choose whether each script runs as the SSH user or root
- Define safe dropdown arguments and file selections for scripts
- Run scripts and follow their logs live
- Keep script execution history with status, timing, arguments, and per-run logs
- Configure cooldown-based health alerts and retain compact system metric history
- Export and restore dashboard configuration without exporting credentials
- Create, edit, pause, and delete guided cron schedules or one-line custom commands (root schedules require approved scripts)
- Browse, edit, and delete files inside explicitly allowed directories
- Authorize and revoke individual browsers
- Restrict access to a LAN subnet, with optional Tailscale access

## Screenshots

All screenshots below use anonymized demonstration data only.

### Containers and storage monitoring

![Containers dashboard with generic services and storage metrics](docs/screenshots/containers-demo.png)

### Script and cron execution history

![Execution history dashboard with generic demo data](docs/screenshots/history-demo.png)

## Install

This quick guide assumes the dashboard will control the same Linux server on
which Docker is running. Docker Engine, Docker Compose, `curl`, `ssh-keygen`,
`ssh-keyscan`, and `openssl` must be installed.

### 1. Download the two configuration files

```bash
mkdir -p ~/linux-server-control/{data,ssh}
cd ~/linux-server-control
curl -fsSLo compose.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.github.yaml
curl -fsSLo .env https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/.env.example
```

The Compose file pulls the ready-made image:

```yaml
image: ghcr.io/florincamarut1/linux-server-control:latest
```

### 2. Enter your server details

```bash
nano .env
```

Replace the example user, IP address, LAN subnet, and folders. The SSH user must
be able to run Docker commands. Keep the dashboard on a trusted LAN or VPN.

### 3. Create the SSH key

Replace `192.168.1.100` below with the same address used in `SSH_TARGET`:

```bash
ssh-keygen -t ed25519 -N '' -C linux-server-control -f ssh/id_ed25519
cat ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
ssh-keyscan -H 192.168.1.100 > ssh/known_hosts
chmod 600 ssh/id_ed25519 ssh/known_hosts
```

### 4. Create the HTTPS certificate

Replace the IP in both places:

```bash
openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -keyout data/key.pem -out data/cert.pem \
  -subj '/CN=192.168.1.100' -addext 'subjectAltName=IP:192.168.1.100'
chmod 600 data/key.pem
sudo chown -R 1000:1000 data ssh
```

### 5. Start it

```bash
docker compose up -d
docker compose logs dashboard
```

Open `https://YOUR_SERVER_IP:8443`. Your browser will warn about the local
self-signed certificate. Use the setup token shown in the logs to create the
administrator account. The first browser is authorized automatically.

To update later:

```bash
docker compose pull
docker compose up -d
```

For remote servers, root scripts, Tailscale, backups, and troubleshooting, see
the **[complete installation guide](INSTALL.md)**.

## Security model

- The dashboard service is not published directly; Caddy is the only exposed container.
- Caddy accepts LAN traffic only from `LAN_CIDR`.
- Passwords are hashed with scrypt.
- New browsers require a short-lived enrollment code.
- Session and device cookies are HTTP-only, secure, and SameSite strict.
- Five failed passwords from one address trigger a 15-minute block.
- SSH host-key verification is mandatory.
- File and script access is limited to `ALLOWED_PATHS`.
- Containers run with a read-only filesystem, dropped Linux capabilities, and `no-new-privileges`.

An authorized dashboard user can control Docker and files inside the configured locations. Docker access commonly grants root-equivalent control over the host. Keep the dashboard on trusted private networks, use a long unique password, and never forward port `8443` from the internet.

## Development

```bash
npm ci
npm run dev
```

Production verification:

```bash
npm run build
```

## License

[MIT](LICENSE)
