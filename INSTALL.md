# Installation

This guide installs Linux Server Control on the server it will manage. One command does it all; the same installation is also described step by step, for those who want to see or change each part:

1. [Install Docker](#step-1-install-docker)
2. [Download the two files](#step-2-download-the-files)
3. [Fill in `.env`](#step-3-fill-in-env)
4. [Create the SSH key](#step-4-create-the-ssh-key)
5. [Start the dashboard](#step-5-start-the-dashboard)
6. [Sign in for the first time](#step-6-sign-in-for-the-first-time)

Run every command on the server, signed in as the normal user account you administer it with (not `root`). No Git clone, Node.js, proxy or certificate is needed.

## Install with one command

```bash
curl -fsSL https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/install.sh | sh
```

The installer does steps 1 to 5 for you:

- It checks the server and lists what is missing: the SSH server, Docker and Docker Compose, your account in the `docker` group, and, where the `ufw` firewall is on, a rule that lets the dashboard's container reach SSH. It shows the `sudo` commands for these and runs them only after you agree. It offers `python3`, `file` and `cron` as well, which the Files page, the file editor and Schedules use.
- It asks four things, each with a suggestion you can keep by pressing Enter: the server's address on your network, the folders the dashboard may manage (`~/scripts` unless you name others), the disks to show as storage cards (the mounts under `/mnt`, `/media` and `/srv`, or `/` when there are none), and whether to serve the dashboard over [HTTPS](#optional-https) as well (no unless you answer yes).
- It creates `~/linux-server-control` with `compose.yaml`, `.env`, the dashboard's own SSH key, allowed to sign in to your account, and the server's recorded identity, and checks that the key signs in.
- It starts the dashboard, checks from inside its container that it reaches the server over SSH, and prints the address to open and the one-time setup token.

Then continue at [step 6](#step-6-sign-in-for-the-first-time). The installer supports Debian, Ubuntu, Fedora, Arch (also CachyOS and Manjaro) and openSUSE; elsewhere it says what is missing, and the steps below do the rest.

To read the script before running it:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/install.sh
less install.sh
sh install.sh
```

Running it again updates the dashboard and keeps its settings, key and data. It also finds a dashboard installed in another folder, by hand or by an earlier version, from its running container, and updates it there. Without a terminal, for example from another script, it asks nothing: it keeps every suggestion and runs no `sudo` command, unless `LSC_YES=1` agrees to them. `sh install.sh --help` lists the variables that answer its questions in advance.

To turn HTTPS on later, or off, run it again with `LSC_HTTPS=yes` (or `no`):

```bash
curl -fsSL https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/install.sh | LSC_HTTPS=yes sh
```

## What you need

| Needed on the server | Used for | Package |
|---|---|---|
| An SSH server and a normal user account | Everything | `openssh-server` |
| `bash`, `free`, `df` | The dashboard itself | Present on every mainstream distribution |
| GNU `realpath`, `du`, `stat`, `tail` | Storage cards, file checks, folder sizes | `coreutils` |
| `python3` | The Files page and the script picker | `python3` |
| `file` | The file editor | `file` |
| `crontab` | Schedules | `cron` (Debian, Ubuntu) or `cronie` (Arch, Fedora) |
| Docker, usable by your account | Running the dashboard, and the Containers page | Step 1 |

Only the first two rows are strictly required. If something else is missing, the dashboard still starts, tells you during setup what is missing, and only the matching page is affected. Systems that have BusyBox instead of GNU coreutils, such as Alpine, are not supported.

The login shell of the account does not matter: bash, zsh and fish all work.

To install the optional tools in one go:

```bash
sudo apt install python3 file cron          # Debian, Ubuntu
sudo dnf install python3 file cronie        # Fedora
sudo pacman -S python file cronie           # Arch
```

On Fedora and Arch, also start cron: `sudo systemctl enable --now crond` (Fedora) or `cronie` (Arch).

## Step 1: Install Docker

Skip this step if both commands already print a version:

```bash
docker --version
docker compose version
```

Otherwise follow Docker's guide for your distribution: [Docker Engine](https://docs.docker.com/engine/install/) and the [Compose plugin](https://docs.docker.com/compose/install/linux/). On a personal Ubuntu or Debian server, this is the short way:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
rm get-docker.sh
```

Then allow your account to use Docker:

```bash
sudo usermod -aG docker "$USER"
```

**Sign out and back in**, then check:

```bash
docker run --rm hello-world
```

You should see "Hello from Docker!". The `docker` group has root-equivalent control over the server, so only add an account you trust.

## Step 2: Download the files

```bash
mkdir -p ~/linux-server-control/{data,ssh}
cd ~/linux-server-control
curl -fsSLo compose.yaml https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/compose.github.yaml
curl -fsSLo .env https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/.env.example
chmod 700 data ssh
```

You now have a folder with `compose.yaml`, `.env`, and two empty folders: `data` (the dashboard's own data) and `ssh` (its SSH key).

## Step 3: Fill in `.env`

First find the server's address on your network. It is the first address this prints, usually starting with `192.168.` or `10.`:

```bash
hostname -I
```

Put the address and your user name into `.env`. Replace `192.168.1.50` with your address; `$USER` is filled in for you:

```bash
cd ~/linux-server-control
SERVER_IP=192.168.1.50
sed -i "s/192.168.1.100/$SERVER_IP/g; s/youruser/$USER/g" .env
```

Then open the file and set the folders:

```bash
nano .env
```

| Setting | What to put there |
|---|---|
| `LAN_IP` | Already filled in. The address the dashboard listens on. |
| `SSH_TARGET` | Already filled in, as `user@address`. |
| `SSH_PORT` | Change it only if your SSH server does not use port 22. |
| `ALLOWED_PATHS` | The folders the dashboard may browse, edit and run scripts from, separated by commas. Use folders that exist, for example `/home/you/scripts`. |
| `SCRIPT_ROOT` | Where the script picker opens. Your home folder is fine. |
| `MONITORED_PATHS` | Disks or mounts to show as storage cards, for example `/mnt/media`. Use `/` if you have none. |
| `REMOTE_LOGS` | Where schedules write their log. The default is fine. |
| `VERSION` | `latest`, or a release number such as `0.5.0` to stay on that release. |

Two rules for `ALLOWED_PATHS`: everyone who can sign in can change every file in these folders, so keep them narrow; and never use `/`, all of `/home`, `.ssh`, or this installation's `data` and `ssh` folders.

All of these except `LAN_IP` and `VERSION` can be changed later in the dashboard, under **Settings**.

<details>
<summary>The server's address changes, or you use Tailscale or another VPN</summary>

`LAN_IP` must be an address the server really has; if it changes, the container cannot start. Give the server a fixed address in your router.

To reach the dashboard on several networks, for example LAN and Tailscale, set `LAN_IP=0.0.0.0`. The dashboard then listens on every network, so make sure your firewall and router do not expose port `8443` to the internet. Leave `SSH_TARGET` on the real address.
</details>

## Step 4: Create the SSH key

The dashboard runs in a container and controls the server over SSH, with a key of its own. Create the key and allow it to sign in to your account:

```bash
cd ~/linux-server-control
ssh-keygen -t ed25519 -N '' -C linux-server-control -f ssh/id_ed25519
mkdir -p ~/.ssh
cat ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys ssh/id_ed25519
```

Record the server's identity, so the dashboard only ever connects to this server. Use the same address as in `.env`; if you opened a new terminal since step 3, run `SERVER_IP=...` again first:

```bash
ssh-keyscan -H "$SERVER_IP" > ssh/known_hosts
chmod 600 ssh/known_hosts
```

If your SSH port is not 22, use `ssh-keyscan -p YOUR_PORT -H "$SERVER_IP" > ssh/known_hosts`.

Check that the recorded identity is this server's. The two commands must print the same `SHA256:` value on one of their lines:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh-keygen -lf ssh/known_hosts
```

Finally, hand both folders to the container, which runs as user number 1000:

```bash
sudo chown -R 1000:1000 data ssh
```

If `id -u` prints something other than `1000` for your account, you will need `sudo` to look into `data` and `ssh` from now on.

## Step 5: Start the dashboard

```bash
cd ~/linux-server-control
docker compose up -d
docker compose ps
```

After about half a minute, `docker compose ps` shows the `dashboard` container as `healthy`.

## Step 6: Sign in for the first time

Print the one-time setup token:

```bash
docker compose logs dashboard | grep "setup token"
```

Open `http://YOUR_SERVER_IP:8443` in a browser on the same network and fill in the form:

- **Setup token**: the token you just printed.
- **Username** and **Password**: choose them; the password needs at least 12 characters.
- The connection fields are filled in from `.env`. Leave them as they are.

Choose **Finish setup**. The dashboard connects to the server and checks what is installed. If something from [What you need](#what-you-need) is missing, it lists it; nothing is blocked, so continue and install it when convenient.

That browser is now authorized. Every other browser or phone needs an access code the first time: create one under **Settings → Authorized browsers → Generate access code**. The [user guide](docs/USER-GUIDE.md) continues from here.

If setup reports that the server connection could not be verified, see [Troubleshooting](#troubleshooting).

## Optional: run scripts and schedules as root

By default every script and schedule runs as your SSH user. Two small helpers, installed with `sudo`, let chosen scripts run as root without giving the dashboard general `sudo`.

Copy the installers out of the image, and read the four short files in `root-helpers/` before running them:

```bash
cd ~/linux-server-control
docker compose cp dashboard:/app/scripts ./root-helpers
```

Create a folder for root scripts that only root can write:

```bash
sudo mkdir -p /srv/dashboard-root-scripts
sudo chown root:root /srv/dashboard-root-scripts
sudo chmod 755 /srv/dashboard-root-scripts
```

Install the helpers for your SSH user:

```bash
sudo sh root-helpers/install-root-script-access.sh "$USER" /srv/dashboard-root-scripts
sudo sh root-helpers/install-root-cron-access.sh "$USER"
```

Then, in the dashboard, add `/srv/dashboard-root-scripts` to **Settings → Server connection → Allowed paths**, so its scripts can be registered.

- The first helper allows root runs only for `.sh` files inside the folders you name. Never make such a folder writable by the SSH user: whoever can edit a root script can run anything as root.
- The first helper also stops a root run when you stop it in the dashboard or it passes its script's time limit. It can only stop runs it started itself.
- The second helper lets the dashboard manage root's crontab. Root schedules need both helpers, and run only registered scripts from the approved folders.

A first helper installed by an earlier version of the dashboard cannot stop root runs. To update it, copy the installers out of the image again and run `install-root-script-access.sh` again with the same folders. **Settings → Server connection → Check server requirements** says when the helper needs this.

## Optional: HTTPS

The dashboard is served over plain HTTP, which is acceptable on a home network you trust. HTTPS also lets browsers save your password and lets Android phones and computers [install it as an app](docs/USER-GUIDE.md#on-a-phone). For HTTPS, the Compose file includes a Caddy service that is off by default. The installer turns it on when you answer yes, or when it runs with `LSC_HTTPS=yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/install.sh | LSC_HTTPS=yes sh
```

It does what HTTPS needs: it sets `COOKIE_SECURE=true`, so that sign-in cookies travel over HTTPS only; it sets `HTTPS_HOST` to the server's address, which the certificate is made for, also when `LAN_IP=0.0.0.0` makes the dashboard listen on every network; it starts the dashboard with `--profile https`; and it checks that HTTPS answers. By hand, in the dashboard's folder:

```bash
echo "COOKIE_SECURE=true" >> .env
echo "HTTPS_HOST=YOUR_SERVER_IP" >> .env
docker compose --profile https up -d
```

Open `https://YOUR_SERVER_IP:8444`; port 8443 stays plain HTTP, where signing in no longer works once `COOKIE_SECURE=true`. Caddy creates its own certificate authority, so browsers warn until you trust it, and do not offer to save the password until then. Trust it once on each device: **Settings → HTTPS certificate** (or **Save the password in this browser** on the sign-in page) downloads the authority's root certificate and shows the steps for the device's system, with the certificate's fingerprint to compare. The root is valid for ten years. The same file is also at:

```bash
docker compose cp https:/data/caddy/pki/authorities/local/root.crt .
```

To use a name instead of the address, set `HTTPS_HOST=server.lan` in `.env`. With `COOKIE_SECURE=true`, sign-in works only over HTTPS, so use port `8444` from then on; each browser enrolls once more under the new address.

An older compose.yaml, whose `https` service runs `caddy reverse-proxy`, offers no download of the root certificate and fails with browsers on an IP address, which send no server name; run the installer again, or download compose.github.yaml again as compose.yaml.

For a certificate made another way, mount its public certificate into the dashboard container and set `HTTPS_CA_CERT` to its path in `.env`; the download then offers that file. Only the public certificate is read, never a key.

## Accounts for other people

The account created at setup is the owner. Under **Settings → Accounts** an administrator can add more: administrators, or read-only accounts that see status, history and logs but cannot change anything. A new browser needs an access code the first time, whichever account signs in.

## Update

Run the [installer](#install-with-one-command) again, or:

```bash
cd ~/linux-server-control
docker compose pull
docker compose up -d
```

Your settings and history stay in `data/`. Refresh the page in your browsers afterwards.

## Backup

Back up `.env`, `data/` and `ssh/`, and keep the copy private: they contain the dashboard configuration, password hashes, authorized devices, run logs and the SSH private key.

## Locked out

Each of these is solved on the server, in the dashboard's folder. Scripts, schedules, history and the other accounts stay as they are.

**No authorized browser is left**, for example after clearing the browser's cookies. Create an access code on the command line, then enter it on the sign-in page under **New browser? Enter an enrollment code**:

```bash
cd ~/linux-server-control
docker compose exec dashboard node scripts/enroll.mjs
```

**The owner's password is forgotten.** Set a new one of at least 12 characters; the username stays the same:

```bash
cd ~/linux-server-control
docker compose exec -e DASHBOARD_PASSWORD='a new long password' dashboard node scripts/setup.mjs
```

Other accounts get a new password from an administrator, under **Settings → Accounts**.

**The server's address changed.** Four things still point to the old address:

1. `LAN_IP` in `.env`: set the new address, then run `docker compose up -d`.
2. `ssh/known_hosts`: repeat the `ssh-keyscan` and `chown` commands of [step 4](#step-4-create-the-ssh-key) with the new address.
3. Your browsers, which were authorized for the old address: create an access code with the first command of this section.
4. The SSH target stored in the dashboard: after signing in it says "Server unavailable". Open **Change the connection settings** on that screen and enter the new SSH target. It is saved only if the server answers.

Give the server a fixed address in your router to avoid all of this.

## Uninstall

```bash
cd ~/linux-server-control
docker compose --profile https down --volumes
sed -i '/linux-server-control$/d' ~/.ssh/authorized_keys
cd ~ && sudo rm -rf ~/linux-server-control
```

The second command removes the dashboard's key from your account. If you installed the root helpers, also remove `/usr/local/sbin/media-dashboard-root-*`, `/etc/sudoers.d/media-dashboard-root-*` and `/etc/media-dashboard`. Schedules created in the dashboard stay in your crontab until you delete them there (`crontab -e`, lines ending in `# media-dashboard:`), so delete them in the dashboard first.

## Troubleshooting

Start with the container's state and its log:

```bash
cd ~/linux-server-control
docker compose ps
docker compose logs --tail 200 dashboard
```

**The container does not start, with "cannot assign requested address".** `LAN_IP` in `.env` is not an address of this server. Compare it with `hostname -I`.

**The browser cannot open the page.** Confirm that the server's firewall allows port `8443` (for example `sudo ufw allow from 192.168.1.0/24 to any port 8443`), and that you are on the same network.

**Setup says the server connection could not be verified.** Run the same connection by hand; it prints the server's name when it works, and the reason when it does not:

```bash
set -a; . ./.env; set +a
docker compose exec -T dashboard ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i /run/ssh/id_ed25519 -p "${SSH_PORT:-22}" -o UserKnownHostsFile=/run/ssh/known_hosts \
  "$SSH_TARGET" hostname
```

- `Permission denied (publickey)`: the key is not in `~/.ssh/authorized_keys` of the account in `SSH_TARGET`; repeat the `cat` command of step 4.
- `Host key verification failed`: `ssh/known_hosts` was made for another address or port than `SSH_TARGET` and `SSH_PORT`; repeat the `ssh-keyscan` command of step 4.
- `Load key ... Permission denied`: the container cannot read the key; repeat the `chown` command of step 4.
- `Connection refused` or a timeout: the address or port is wrong, or the SSH server is not running.

**"Containers cannot be read".** The message says why: Docker is not installed, its daemon is stopped, or the SSH user is not in the `docker` group. For the last one, run `sudo usermod -aG docker "$USER"` and then `docker compose restart`.

**A page reports a missing command.** Open **Settings → Server connection → Check server requirements** and install what it lists.

**Setup says the server connection could not be verified, and the server has the `ufw` firewall.** `ufw` also drops the container's connection to SSH; the installer adds a rule for it. By hand: `sudo ufw allow from 172.16.0.0/12 to any port 22 proto tcp`, which lets Docker's networks, and nothing else, reach SSH.

**The setup token is not in the log.** It is printed on every start until setup is completed, so `docker compose restart` followed by the `grep` of step 6 shows it again. It is also stored in `data/setup-bootstrap.json` (`sudo cat data/setup-bootstrap.json`).
