# Installation

This guide installs Linux Server Control on the Linux server it manages. The dashboard uses Docker and SSH to connect back to that same server.

Use a normal Linux account that can run `docker ps` and manage its own crontab. The examples use `serveradmin`; replace it everywhere with your account and server IP.

## 1. Install Docker

Skip this section when `docker --version` and `docker compose version` already work.

Use Docker's official installation guide for your distribution:

- [Docker Engine](https://docs.docker.com/engine/install/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)

On Ubuntu or Debian, Docker's convenience script is a quick option for a personal server:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
rm get-docker.sh
sudo usermod -aG docker "$USER"
```

Sign out and back in, then verify:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Being in the `docker` group is root-equivalent access to the host. Use only a trusted account.

## 2. Install Linux Server Control

Create a small directory for the Compose file, dashboard data, certificates, and SSH key. This installation pulls the published image—there is no repository clone.

```bash
mkdir -p ~/linux-server-control/{data,ssh}
cd ~/linux-server-control
curl -fsSLo compose.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.github.yaml
curl -fsSLo .env https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/.env.example
chmod 700 data ssh
```

## 3. Configure the dashboard

Open `.env` and replace the example values:

```bash
nano .env
```

Minimum example:

```dotenv
LAN_IP=192.168.1.100
LAN_CIDR=192.168.1.0/24
SSH_TARGET=serveradmin@192.168.1.100
SCRIPT_ROOT=/home/serveradmin
ALLOWED_PATHS=/home/serveradmin/scripts,/mnt/media
MONITORED_PATHS=/mnt/media
REMOTE_LOGS=/home/serveradmin/.local/state/media-dashboard
```

`ALLOWED_PATHS` is the security boundary for Files and Scripts. List only folders that should be browsed, edited, or used for scripts—never `/`, `.ssh`, or the dashboard's `data` and `ssh` folders.

## 4. Create the SSH key

The container needs a dedicated key to reach the managed server without a password. For a same-server setup, authorize it for your current account:

```bash
cd ~/linux-server-control
ssh-keygen -t ed25519 -N '' -C linux-server-control -f ssh/id_ed25519
cat ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys ssh/id_ed25519
ssh-keyscan -H 192.168.1.100 > ssh/known_hosts
chmod 600 ssh/known_hosts
```

Compare the fingerprint before continuing:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf ssh/known_hosts
```

Use the exact hostname or IP from `SSH_TARGET` when running `ssh-keyscan`.

## 5. Create the LAN certificate

The dashboard uses HTTPS. Create a local certificate for the LAN IP:

```bash
cd ~/linux-server-control
openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
  -keyout data/key.pem -out data/cert.pem \
  -subj '/CN=192.168.1.100' \
  -addext 'subjectAltName=IP:192.168.1.100'
chmod 600 data/key.pem
sudo chown -R 1000:1000 data ssh
```

Replace `192.168.1.100` with `LAN_IP`. Your browser will ask you to accept the self-signed certificate unless you trust it locally.

## 6. Start and finish setup

```bash
cd ~/linux-server-control
docker compose up -d
docker compose logs dashboard
```

Open `https://YOUR_LAN_IP:8443`. Copy the one-time setup token from the dashboard logs, create the administrator password, and confirm the server connection in the setup form. The first browser is authorized automatically.

Verify the services any time with:

```bash
docker compose ps
docker compose logs --tail 100 dashboard proxy
```

## Optional: Tailscale

For trusted HTTPS access from a tailnet, download the two Tailscale files into the installation directory, then add the variables below to `.env`:

```bash
cd ~/linux-server-control
curl -fsSLo compose.tailscale.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.tailscale.yaml
curl -fsSLo Caddyfile.tailscale https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/Caddyfile.tailscale
```

```dotenv
TAILSCALE_IP=100.64.0.10
TAILSCALE_HOST=your-server.your-tailnet.ts.net
COMPOSE_FILE=compose.yaml:compose.tailscale.yaml
```

Issue a certificate and recreate the proxy:

```bash
sudo tailscale cert --cert-file data/tailscale.crt --key-file data/tailscale.key your-server.your-tailnet.ts.net
sudo chown 1000:1000 data/tailscale.crt data/tailscale.key
chmod 600 data/tailscale.key
docker compose up -d --force-recreate proxy
```

Open `https://your-server.your-tailnet.ts.net:8443`—not the raw Tailscale IP.

## Optional: root schedules and scripts

Normal scripts and schedules run as the SSH user. Root access is deliberately separate and should be enabled only after reviewing the helper scripts and allowed directories:

```bash
sudo ./scripts/install-root-cron-access.sh serveradmin
sudo ./scripts/install-root-script-access.sh serveradmin /srv/dashboard-root-scripts
```

Root-approved script folders must be owned by root and not writable by the SSH account.

## Backup and troubleshooting

Back up `.env`, `data/`, and `ssh/` securely. They contain TLS and SSH private keys, password hashes, devices, and run logs.

If the dashboard cannot connect to the server, first check the containers, then test SSH from the dashboard container:

```bash
docker compose ps
docker compose logs --tail 200 dashboard proxy
set -a; . ./.env; set +a
docker compose exec -T dashboard ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i /run/ssh/id_ed25519 -o UserKnownHostsFile=/run/ssh/known_hosts \
  "$SSH_TARGET" hostname
```
