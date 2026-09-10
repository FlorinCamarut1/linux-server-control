# Installation

The setup has two independent parts: install Docker once, then install Linux Server Control.

## 1. Install Docker

Skip this section if both commands already work:

```bash
docker --version
docker compose version
```

Use Docker's official guide for your distribution:

- [Docker Engine](https://docs.docker.com/engine/install/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)

Quick install for a personal Ubuntu or Debian server:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
rm get-docker.sh
sudo usermod -aG docker "$USER"
```

Sign out and back in, then verify:

```bash
docker run --rm hello-world
```

The `docker` group has root-equivalent control over the host. Use only a trusted account.

## 2. Install Linux Server Control

No Git clone, Node.js, proxy, or certificate is required. Download only Compose and the environment template:

```bash
mkdir -p ~/linux-server-control/{data,ssh}
cd ~/linux-server-control
curl -fsSLo compose.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.github.yaml
curl -fsSLo .env https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/.env.example
chmod 700 data ssh
```

## 3. Configure `.env`

```bash
nano .env
```

Replace `youruser` and `192.168.1.100` with the Linux account and LAN IP of your server:

```dotenv
LAN_IP=192.168.1.100
SSH_TARGET=youruser@192.168.1.100
SCRIPT_ROOT=/home/youruser
ALLOWED_PATHS=/home/youruser/scripts,/mnt/media
MONITORED_PATHS=/mnt/media
REMOTE_LOGS=/home/youruser/.local/state/media-dashboard
METRICS_RETENTION_DAYS=30
```

Keep `ALLOWED_PATHS` narrow. Do not use `/`, all of `/home`, `.ssh`, or this installation's `data` and `ssh` folders.

## 4. Create the SSH key

The dashboard container connects to the server with a dedicated key:

```bash
cd ~/linux-server-control
ssh-keygen -t ed25519 -N '' -C linux-server-control -f ssh/id_ed25519
cat ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys ssh/id_ed25519
ssh-keyscan -H 192.168.1.100 > ssh/known_hosts
chmod 600 ssh/known_hosts
sudo chown -R 1000:1000 data ssh
```

Use the same IP or hostname as `SSH_TARGET`. Verify the fingerprint through a trusted terminal before continuing:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf ssh/known_hosts
```

## 5. Start the dashboard

```bash
cd ~/linux-server-control
docker compose up -d
docker compose logs dashboard
```

Open `http://YOUR_SERVER_IP:8443`, use the one-time token shown in the logs, create the account, and confirm the SSH settings. The first browser is authorized automatically.

## Update

```bash
cd ~/linux-server-control
docker compose pull
docker compose up -d
```

## Backup

Back up `.env`, `data/`, and `ssh/` securely. They contain the dashboard configuration, password hashes, authorized devices, run logs, and SSH private key.

## Troubleshooting

```bash
docker compose ps
docker compose logs --tail 200 dashboard
set -a; . ./.env; set +a
docker compose exec -T dashboard ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i /run/ssh/id_ed25519 -o UserKnownHostsFile=/run/ssh/known_hosts \
  "$SSH_TARGET" hostname
```

If the browser cannot connect, confirm that port `8443` is allowed by the server firewall and that no router forwards it from the public internet.
