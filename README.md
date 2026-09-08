# Linux Server Control

Linux Server Control is a self-hosted dashboard for administering one Linux server from a browser. It is built with Next.js and TypeScript and runs as Docker containers.

## Features

- View running and stopped Docker containers
- Start, stop, restart, and inspect container logs
- Register shell scripts and organize them into folders
- Define safe dropdown arguments and file selections for scripts
- Run scripts and follow their logs live
- Create, edit, pause, and delete guided cron schedules
- Browse, edit, and delete files inside explicitly allowed directories
- Authorize and revoke individual browsers
- Restrict access to a LAN subnet, with optional Tailscale access

## Quick start

The default installation is LAN-only. It uses a dedicated SSH key so the dashboard container can execute approved operations on the host.

See **[INSTALL.md](INSTALL.md)** for the complete installation tutorial, optional root cron support, Tailscale HTTPS, upgrades, and troubleshooting.

```bash
git clone https://github.com/Florincamarut1/linux-server-control.git
cd linux-server-control
cp .env.example .env
```

Edit `.env`, then follow the key and certificate setup in the installation guide.

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
