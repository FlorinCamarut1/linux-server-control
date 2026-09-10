# Installation guide

This guide installs Linux Server Control on the Linux server it will manage. The default setup is accessible only from the local network. Tailscale is optional.

## 1. Requirements

Install Docker Engine with the Docker Compose plugin, OpenSSH, OpenSSL, and Git. Choose a normal Linux user that can run `docker ps` and manage its own crontab. The examples use `serveradmin`; replace it with your account name. Give the server a fixed LAN address or DHCP reservation.

```bash
docker --version
docker compose version
ssh localhost true
```

If your user cannot access Docker, follow the Docker documentation for your distribution. Membership in the `docker` group grants root-equivalent host access.

## 2. Download the project

```bash
cd /home/serveradmin
git clone https://github.com/Florincamarut1/linux-server-control.git
cd linux-server-control
cp .env.example .env
mkdir -p data ssh
chmod 700 data ssh
```

## 3. Configure the environment

Edit `.env`:

```dotenv
LAN_IP=192.168.1.100
LAN_CIDR=192.168.1.0/24
SSH_TARGET=serveradmin@192.168.1.100
SCRIPT_ROOT=/home/serveradmin
ALLOWED_PATHS=/home/serveradmin/scripts,/home/serveradmin/services,/mnt/media
REMOTE_LOGS=/home/serveradmin/.local/state/linux-server-control
DASHBOARD_USER=admin
```

Use the server's real LAN IP in `LAN_IP` and `SSH_TARGET`. `LAN_CIDR` is the subnet allowed to reach the dashboard.

`ALLOWED_PATHS` is the comma-separated allowlist used by the Files page and script selectors. Add only directories that the dashboard should read, edit, or delete. Do not allow `/`, `/home`, an entire home directory, `.ssh`, or this project's `data` and `ssh` directories.

The **New custom script** action writes an executable `.sh` file only to a folder selected from this allowlist. Custom cron commands are also available from the Scheduled jobs page; they run as the selected SSH user or, when enabled, root.

## 4. Create the dashboard SSH key

Generate a dedicated key without a passphrase because the container must use it unattended:

```bash
ssh-keygen -t ed25519 -N '' -C linux-server-control -f ssh/id_ed25519
cat ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys ssh/id_ed25519
```

Record the server's SSH host key:

```bash
ssh-keyscan -H 192.168.1.100 > ssh/known_hosts
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf ssh/known_hosts
```

Compare the fingerprints through a trusted local session before continuing. If `SSH_TARGET` uses a hostname, scan that exact hostname instead.

Make the persistent files writable by the `node` user inside the dashboard container:

```bash
sudo chown -R 1000:1000 data ssh
```

## 5. Create the LAN certificate

Generate a certificate containing the server's LAN IP:

```bash
openssl req -x509 -newkey rsa:3072 -nodes \
  -keyout data/key.pem \
  -out data/cert.pem \
  -days 365 \
  -subj '/CN=linux-server-control' \
  -addext 'subjectAltName=IP:192.168.1.100'
chmod 600 data/key.pem
```

Replace the example IP. Browsers will warn about this self-signed certificate until you explicitly trust it on each device. Access remains restricted to `LAN_CIDR`.

## 6. Start and create the account

The standalone installation uses the published image:

```yaml
image: ghcr.io/florincamarut1/linux-server-control:latest
```

```bash
docker compose up -d
```

Open the dashboard, get the one-time setup token with
`docker compose logs dashboard`, and create the administrator account in the
browser. The password must contain at least 12 characters. It can later be
changed from **Account**. Source checkouts using `compose.yaml` build locally;
the standalone `compose.github.yaml` pulls the published GHCR image.

Verify the deployment:

```bash
docker compose ps
docker compose logs --tail 100 dashboard proxy
docker compose exec -T dashboard ssh \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -i /run/ssh/id_ed25519 \
  -o UserKnownHostsFile=/run/ssh/known_hosts \
  "$SSH_TARGET" hostname
```

Open `https://192.168.1.100:8443` and accept or trust your local certificate.

## 7. Authorize the first browser

```bash
docker compose run --rm dashboard node scripts/enroll.mjs
```

On the login screen, expand **New browser**, enter the one-time code and a device name, then sign in. The code expires after 15 minutes and is consumed after use. Future codes can be created from the Devices page.

## 8. Optional root cron support

Normal schedules run as the SSH user and need no additional setup. To display and manage root cron jobs, install the helper:

```bash
sudo ./scripts/install-root-cron-access.sh serveradmin
sudo -n /usr/local/sbin/media-dashboard-root-cron list
```

Replace `serveradmin` with the user from `SSH_TARGET`. This permission allows the dashboard to replace root's crontab and therefore grants root-level command execution. Enable it only for a trusted administrator.

## 9. Optional root script support

The Scripts form can run a registered script as root, but only after installing the separate root-script helper. List each directory from which root scripts may run:

```bash
sudo ./scripts/install-root-script-access.sh serveradmin \
  /home/serveradmin/scripts \
  /home/serveradmin/services
sudo -n /usr/local/sbin/media-dashboard-root-run status
```

After this, select **root** in the script's **Run as** field. The helper accepts only existing non-symlink `.sh` files under the listed directories. It does not grant generic sudo access.

## 10. Optional Tailscale access with trusted HTTPS

Skip this section for a LAN-only installation.

Install Tailscale, connect the server to your tailnet, and enable MagicDNS and HTTPS certificates in the Tailscale admin console. Run `tailscale ip -4` and `tailscale cert` to find the server values.

Add these lines to `.env`:

```dotenv
TAILSCALE_IP=100.64.0.10
TAILSCALE_HOST=your-server.your-tailnet.ts.net
COMPOSE_FILE=compose.yaml:compose.tailscale.yaml
```

Issue a certificate using the exact hostname reported by `tailscale cert`:

```bash
sudo tailscale cert \
  --cert-file data/tailscale.crt \
  --key-file data/tailscale.key \
  your-server.your-tailnet.ts.net
sudo chown 1000:1000 data/tailscale.crt data/tailscale.key
chmod 600 data/tailscale.key
docker compose up -d --force-recreate proxy
```

Open `https://your-server.your-tailnet.ts.net:8443`. The proxy is bound to the server's Tailscale IP, so it is reachable through the tailnet only. Do not browse to the raw Tailscale IP when using the hostname certificate.

Tailscale certificates expire and must be renewed. Automate `tailscale cert --min-validity 720h` with a root systemd timer or cron job and restart the proxy after replacing the files.

## Upgrading

```bash
cd /home/serveradmin/linux-server-control
git pull --ff-only
docker compose build dashboard
docker compose up -d --force-recreate
```

Persistent account, device, script, folder, and schedule data remains under `data/` and is excluded from Git.

## Backup

Back up `.env`, `data/`, and `ssh/` securely. They contain configuration, password hashes, browser authorizations, logs, TLS private keys, and the dashboard SSH private key. Never commit them.

## Troubleshooting

```bash
docker compose ps
docker compose logs --tail 200 dashboard proxy
```

If SSH fails, confirm that `SSH_TARGET` matches the host captured in `ssh/known_hosts` and repeat the container SSH test from step 6.

If the browser reports **Invalid request origin**, use the same hostname and port shown in its address bar and make sure no additional proxy rewrites `Host`, `X-Forwarded-Host`, or `X-Forwarded-Proto`.

If a browser is no longer authorized, generate a fresh enrollment code from an authorized browser or with `scripts/enroll.mjs`.
