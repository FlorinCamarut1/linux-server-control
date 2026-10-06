#!/bin/sh
# Installs Linux Server Control on this server, or updates it, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main/install.sh | sh
#
# Run it as the account you administer the server with, not as root. Before it
# changes anything outside its own folder (installing Docker or the SSH server,
# adding you to the docker group), it shows the sudo commands and asks. Run
# again, it updates the dashboard and keeps its settings, key and data. In a
# copy of the source code (sh install.sh in a clone), it builds the dashboard
# from that code instead of downloading the image.
set -eu

USAGE="Usage: sh install.sh

Installs Linux Server Control in ~/linux-server-control, or updates it there.
Each question has a default, and these variables answer them in advance:
  LSC_DIR              installation folder (~/linux-server-control)
  LSC_IP               this server's address on your network (detected); 0.0.0.0
                       makes the dashboard listen on every network
  LSC_SSH_PORT         the port of this server's SSH server (from sshd_config, else 22)
  LSC_ALLOWED_PATHS    folders the dashboard may browse, edit and run scripts from
                       (~/scripts)
  LSC_MONITORED_PATHS  storage shown as cards (the mounts under /mnt, /media and /srv,
                       else /)
  LSC_VERSION          the image to run: latest, or a release such as 0.5.0
  LSC_HTTPS            yes to serve the dashboard over HTTPS as well, on port 8444,
                       or no (no; an update keeps the installation's choice)
  LSC_YES=1            take every default and agree to every change, without asking

An installation in another folder, made by hand or by an earlier version, is
found from its running container and updated there, unless LSC_DIR is set."

SOURCE=${LSC_SOURCE:-https://raw.githubusercontent.com/FlorinCamarut1/linux-server-control/main}
GUIDE=https://github.com/FlorinCamarut1/linux-server-control/blob/main/INSTALL.md
# The container runs as this user ID; its data and key must belong to it.
CONTAINER_UID=1000
NEWLINE='
'

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m') GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD='' GREEN='' YELLOW='' RED='' RESET=''
fi
say() { printf '%s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
missing() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; }
note() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() {
  printf '\n%sThe installation stopped:%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Questions go to the terminal, also when this script is piped into sh. The
# terminal is tried in a subshell: a shell whose redirection of a special
# builtin fails would exit.
tty_ok() { (exec < /dev/tty) 2>/dev/null; }
ask() {
  answer=''
  if [ "${LSC_YES:-}" != 1 ] && tty_ok; then
    printf '%s [%s]: ' "$1" "$2" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=''
    [ -n "$answer" ] || answer=$2
  else
    answer=$2
    say "  $1: $answer"
  fi
}
confirm() {
  [ "${LSC_YES:-}" = 1 ] && return 0
  tty_ok || return 1
  printf '%s [Y/n]: ' "$1" > /dev/tty
  IFS= read -r reply < /dev/tty || reply=''
  case $reply in [Nn]*) return 1 ;; *) return 0 ;; esac
}

fetch() {
  if have curl; then curl -fsSL "$SOURCE/$1" -o "$2" || fail "$SOURCE/$1 could not be downloaded."
  elif have wget; then wget -qO "$2" "$SOURCE/$1" || fail "$SOURCE/$1 could not be downloaded."
  else fail "Neither curl nor wget is installed, so nothing can be downloaded."
  fi
}

# Sets KEY=VALUE in an env file, in place of the line that sets it, if any.
set_env() {
  KEY=$2 VALUE=$3 awk 'index($0, ENVIRON["KEY"] "=") == 1 { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; done = 1; next }
    { print } END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }' "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
}
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

# Whether the folder $2 is $1 or inside it.
within() {
  [ "$2" = "$1" ] && return 0
  case $2 in "$1"/*) return 0 ;; esac
  return 1
}

local_addresses() {
  if have ip; then ip -4 -o addr show 2>/dev/null | awk '{ sub("/.*", "", $4); print $4 }'
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep .
  fi
}
detect_ip() {
  address=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  [ -n "$address" ] || address=$(local_addresses | grep -v '^127\.' | head -n 1)
  printf '%s\n' "$address"
}
# The port in the SSH server's settings: its drop-in files come first, as
# their Include line usually does.
detect_ssh_port() {
  port=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1) == "port" && $2 ~ /^[0-9]+$/ { print $2; exit }')
  printf '%s\n' "${port:-22}"
}
# The SSH server's identity, as known_hosts lines (hashed with -H as $3). One
# connection per question: an SSH server penalises an address that opens many
# connections without signing in (OpenSSH's PerSourcePenalties), and
# ssh-keyscan would open one for every key type.
scan_host() {
  for type in ed25519 ecdsa rsa; do
    lines=$(ssh-keyscan -T 5 -t "$type" -p "$2" ${3:+"$3"} "$1" 2>/dev/null | grep -v '^#') || lines=''
    if [ -n "$lines" ]; then
      printf '%s\n' "$lines"
      return 0
    fi
  done
  return 1
}
ssh_answers() { have ssh-keyscan && scan_host "$1" "$2" >/dev/null; }
# Real file systems mounted under /mnt, /media and /srv: media drives and the like.
detect_mounts() {
  df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null |
    awk 'NR > 1 && $6 ~ /^\/(mnt|media|srv)\// { print $6 }' | sort -u | paste -sd, -
}
in_group() { id -nG ${2:+"$2"} | tr ' ' '\n' | grep -qx "$1"; }
yes_no() {
  case $1 in [Yy]|[Yy][Ee][Ss]|1|[Tt][Rr][Uu][Ee]) printf 'yes\n' ;; [Nn]|[Nn][Oo]|0|[Ff][Aa][Ll][Ss][Ee]) printf 'no\n' ;; *) fail "Answer yes or no: $1" ;; esac
}
# The folder of a dashboard that Docker runs from another folder, such as one
# installed by hand or by an earlier version of this script.
installed_elsewhere() {
  have docker || return 0
  docker ps -a --filter label=com.docker.compose.service=dashboard --format '{{.Image}} {{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null < /dev/null |
    awk '$1 ~ /linux-server-control/ && $2 ~ /^\// { print $2; exit }'
}

# What this server lacks, as commands for root.
PLAN=''
plan() { PLAN="$PLAN$1$NEWLINE"; }
package_manager() {
  for manager in apt-get dnf pacman zypper; do
    if have "$manager"; then printf '%s\n' "$manager"; return; fi
  done
  printf 'none\n'
}
install_packages() {
  case $MANAGER in
    apt-get) plan "DEBIAN_FRONTEND=noninteractive apt-get install -y $*" ;;
    dnf) plan "dnf install -y $*" ;;
    pacman) plan "pacman -S --needed --noconfirm $*" ;;
    zypper) plan "zypper --non-interactive install $*" ;;
    *) fail "This server's package manager is not supported. Install $* yourself, or follow $GUIDE" ;;
  esac
}
# Runs the planned commands with sudo, one by one; with "optional", a failure
# is reported and the rest goes on.
run_planned() {
  have sudo || fail "sudo is not installed. Run the commands above as root, then run this again."
  set -f
  old_ifs=$IFS
  IFS=$NEWLINE
  for command in $PLAN; do
    IFS=$old_ifs
    say "→ sudo $command"
    if ! sudo sh -c "$command" < /dev/null; then
      [ "${1:-}" = optional ] || fail "This command failed: sudo $command"
      note "This command failed: sudo $command"
    fi
  done
  IFS=$old_ifs
  set +f
  PLAN=''
}

check_requirements() {
  say "${BOLD}Checking this server${RESET}"
  MANAGER=$(package_manager)
  if have ssh && have ssh-keygen && have ssh-keyscan; then ok "SSH client"
  else
    missing "SSH client"
    case $MANAGER in apt-get) install_packages openssh-client ;; dnf) install_packages openssh-clients ;; *) install_packages openssh ;; esac
  fi

  if ssh_answers 127.0.0.1 "$SSH_PORT" || { [ -n "${LSC_IP:-}" ] && ssh_answers "$LSC_IP" "$SSH_PORT"; }; then
    ok "SSH server on port $SSH_PORT"
  else
    missing "SSH server (nothing answers on port $SSH_PORT)"
    if ! have sshd && [ ! -x /usr/sbin/sshd ]; then
      case $MANAGER in apt-get|dnf|zypper) install_packages openssh-server ;; *) install_packages openssh ;; esac
    fi
    if [ "$MANAGER" = apt-get ]; then plan "systemctl enable --now ssh"; else plan "systemctl enable --now sshd"; fi
  fi

  DOCKER=docker
  if ! have docker; then
    missing "Docker"
    case $MANAGER in
      apt-get|dnf) plan "curl -fsSL https://get.docker.com | sh" ;;
      pacman|zypper) install_packages docker docker-compose ;;
      *) fail "Install Docker yourself (https://docs.docker.com/engine/install/), then run this again." ;;
    esac
    plan "systemctl enable --now docker"
  else
    if docker compose version >/dev/null 2>&1; then ok "Docker Compose"
    else
      missing "Docker Compose"
      case $MANAGER in
        apt-get) plan "apt-get install -y docker-compose-plugin || apt-get install -y docker-compose-v2" ;;
        dnf) plan "dnf install -y docker-compose-plugin || dnf install -y docker-compose" ;;
        *) install_packages docker-compose ;;
      esac
    fi
    if problem=$(docker info 2>&1 >/dev/null); then ok "Docker service"
    else
      # Without the docker group the daemon cannot be asked; systemd can.
      case $problem in
        *"permission denied"*) systemctl is-active --quiet docker 2>/dev/null || { missing "Docker service (not running)"; plan "systemctl enable --now docker"; } ;;
        *) missing "Docker service (not running)"; plan "systemctl enable --now docker" ;;
      esac
    fi
  fi
  # Membership in the docker group takes effect at the next sign-in, so until
  # then this installation uses Docker through sudo.
  if in_group docker "$USER_NAME"; then
    ok "Your account may use Docker"
    in_group docker || DOCKER="sudo docker"
  else
    missing "Your account is not in the docker group"
    plan "usermod -aG docker $USER_NAME"
    DOCKER="sudo docker"
    JOINED_DOCKER=1
  fi
  # A firewall that drops what it does not allow (ufw) also drops the
  # container's SSH connection to this server; Docker's own rules let the
  # dashboard's published port through. The rule admits Docker's networks only.
  # Where its rules cannot be read, only a new installation adds the rule
  # (adding it again changes nothing, but would ask for sudo on every update).
  if grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
    if [ -r /etc/ufw/user.rules ]; then
      grep -qs -- "--dport $SSH_PORT -s 172.16.0.0/12 -j ACCEPT" /etc/ufw/user.rules || firewall=1
    else
      [ -n "$UPDATE" ] || firewall=1
    fi
    if [ -n "${firewall:-}" ]; then
      note "The firewall (ufw) would stop the dashboard's container from reaching SSH."
      plan "ufw allow from 172.16.0.0/12 to any port $SSH_PORT proto tcp comment 'Linux Server Control'"
    fi
  fi
  CHOWN=''
  if [ "$(id -u)" != "$CONTAINER_UID" ]; then
    CHOWN=1
    note "The dashboard's container runs as user $CONTAINER_UID and you are $(id -u): its folders are handed to it with sudo."
  fi

  OPTIONAL=''
  for tool in python3 file crontab; do have "$tool" || OPTIONAL="$OPTIONAL $tool"; done
  if [ -z "$OPTIONAL" ]; then ok "python3, file, crontab"
  else note "Not installed:$OPTIONAL (the Files page, the file editor and Schedules use them)"
  fi
}

run_plan() {
  [ -n "$PLAN" ] || [ -n "$CHOWN" ] || return 0
  say ""
  say "${BOLD}To continue, these commands run with sudo:${RESET}"
  printf '%s' "$PLAN" | sed 's/^/  sudo /'
  [ -z "$CHOWN" ] || say "  sudo chown -R $CONTAINER_UID:$CONTAINER_UID $DIR/data $DIR/ssh"
  confirm "Run them now?" || fail "Nothing was changed. Run the commands above yourself, then this again, or follow $GUIDE"
  have sudo || fail "sudo is not installed. Run the commands above as root, then run this again."
  sudo -v || fail "sudo did not accept the password."
  run_planned
}

install_optional() {
  [ -n "$OPTIONAL" ] || return 0
  case $MANAGER in
    apt-get) packages="python3 file cron" cron_service='' ;;
    dnf) packages="python3 file cronie" cron_service=crond ;;
    pacman) packages="python file cronie" cron_service=cronie ;;
    zypper) packages="python3 file cronie" cron_service=cron ;;
    *) return 0 ;;
  esac
  confirm "Install$OPTIONAL as well, with sudo ($packages)?" || return 0
  install_packages "$packages"
  [ -z "$cron_service" ] || plan "systemctl enable --now $cron_service"
  run_planned optional
}

choose_settings() {
  say ""
  if [ "${LSC_YES:-}" != 1 ] && tty_ok; then say "${BOLD}Settings${RESET} (press Enter to keep the value in brackets)"
  else say "${BOLD}Settings${RESET}"
  fi
  detected=$(detect_ip)
  ask "This server's address on your network" "${LSC_IP:-$detected}"
  LISTEN=$answer
  case $LISTEN in ''|*[!0-9.]*) fail "$LISTEN is not an IPv4 address." ;; esac
  if [ "$LISTEN" = 0.0.0.0 ]; then IP=$detected
  else
    IP=$LISTEN
    local_addresses | grep -qxF "$IP" || fail "$IP is not an address of this server. Its addresses: $(local_addresses | tr '\n' ' ')"
  fi
  # A server started a moment ago may need a second to listen.
  tries=0
  until ssh_answers "$IP" "$SSH_PORT"; do
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || fail "No SSH server answers on $IP port $SSH_PORT. Set LSC_SSH_PORT if it uses another port."
    sleep 1
  done

  ask "Folders the dashboard may browse, edit and run scripts from, separated by commas" "${LSC_ALLOWED_PATHS:-$HOME/scripts}"
  ALLOWED=''
  set -f
  old_ifs=$IFS
  IFS=,
  for folder in $answer; do
    IFS=$old_ifs
    folder=$(printf '%s' "$folder" | sed 's/^ *//; s/ *$//; s:/*$::')
    [ -n "$folder" ] || folder=/
    case $folder in /*) ;; *) fail "Use absolute folders, such as $HOME/scripts: $folder" ;; esac
    # Everyone who can sign in may change every file in these folders.
    if [ "$folder" = / ] || [ "$folder" = /home ] || [ "$folder" = /root ] || within "$folder" "$HOME/.ssh" || within "$HOME/.ssh" "$folder" || within "$folder" "$DIR" || within "$DIR" "$folder"; then
      fail "$folder is too wide, or holds SSH keys or the dashboard's own files. Choose narrower folders, such as $HOME/scripts."
    fi
    [ -d "$folder" ] || mkdir -p "$folder" 2>/dev/null || note "$folder does not exist yet."
    ALLOWED="${ALLOWED:+$ALLOWED,}$folder"
  done
  IFS=$old_ifs
  set +f

  mounts=$(detect_mounts)
  ask "Storage to show as cards (mounted folders, separated by commas)" "${LSC_MONITORED_PATHS:-${mounts:-/}}"
  MONITORED=$answer

  # HTTPS lets browsers save the password and phones install the dashboard as
  # an app, once each device trusts the certificate (Settings → HTTPS certificate).
  ask "Serve the dashboard over HTTPS as well, on port 8444 (yes or no)" "${LSC_HTTPS:-no}"
  HTTPS=$(yes_no "$answer")
}

# HTTPS: Caddy's service in compose.yaml serves the dashboard on port 8444 with
# a certificate for HTTPS_HOST, and sign-in cookies are sent over HTTPS only.
# HTTPS_HOST is the real address even where the dashboard listens on every
# network (LAN_IP=0.0.0.0); a name set there by hand is kept.
apply_https() {
  if [ "$HTTPS" = yes ]; then
    [ "$(env_value "$1" COOKIE_SECURE)" = true ] || set_env "$1" COOKIE_SECURE true
    [ -n "$(env_value "$1" HTTPS_HOST)" ] || set_env "$1" HTTPS_HOST "$IP"
  elif [ "$(env_value "$1" COOKIE_SECURE)" = true ]; then
    set_env "$1" COOKIE_SECURE false
  fi
}

prepare_files() {
  mkdir -p "$DIR/data" "$DIR/ssh"
  chmod 700 "$DIR/data" "$DIR/ssh" 2>/dev/null || true
  if [ -n "$CHECKOUT" ]; then
    ok "The dashboard is built from the source code in $DIR, with its compose.yaml"
  else
    fetch compose.github.yaml "$DIR/compose.yaml.new"
    if [ -f "$DIR/compose.yaml" ] && [ "$(cksum < "$DIR/compose.yaml")" != "$(cksum < "$DIR/compose.yaml.new")" ]; then
      mv "$DIR/compose.yaml" "$DIR/compose.yaml.bak"
      note "The previous compose.yaml is kept as compose.yaml.bak."
    fi
    mv "$DIR/compose.yaml.new" "$DIR/compose.yaml"
  fi
  if [ -n "$UPDATE" ]; then
    apply_https "$DIR/.env"
    return 0
  fi
  if [ -n "$CHECKOUT" ]; then cp "$DIR/.env.example" "$DIR/.env.new"
  else fetch .env.example "$DIR/.env.new"
  fi
  set_env "$DIR/.env.new" LAN_IP "$LISTEN"
  set_env "$DIR/.env.new" SSH_TARGET "$USER_NAME@$IP"
  set_env "$DIR/.env.new" SSH_PORT "$SSH_PORT"
  set_env "$DIR/.env.new" SCRIPT_ROOT "${ALLOWED%%,*}"
  set_env "$DIR/.env.new" ALLOWED_PATHS "$ALLOWED"
  set_env "$DIR/.env.new" MONITORED_PATHS "$MONITORED"
  set_env "$DIR/.env.new" REMOTE_LOGS "$HOME/.local/state/media-dashboard"
  set_env "$DIR/.env.new" VERSION "${LSC_VERSION:-latest}"
  apply_https "$DIR/.env.new"
  chmod 600 "$DIR/.env.new"
  mv "$DIR/.env.new" "$DIR/.env"
  ok "Settings written to $DIR/.env"
}

prepare_ssh() {
  key=$DIR/ssh/id_ed25519
  if [ ! -e "$key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C linux-server-control -f "$key" < /dev/null
    ok "SSH key created for the dashboard"
  fi
  # The key may sign in to this account.
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  [ -e "$HOME/.ssh/authorized_keys" ] || touch "$HOME/.ssh/authorized_keys"
  chmod 600 "$HOME/.ssh/authorized_keys"
  public=$(cat "$key.pub")
  if ! grep -qxF "$public" "$HOME/.ssh/authorized_keys"; then
    printf '%s\n' "$public" >> "$HOME/.ssh/authorized_keys"
    ok "The key may sign in to $USER_NAME"
  fi

  # The server's identity, so that the dashboard only ever connects to this
  # server; an update keeps the one recorded. Where this server's own keys can
  # be read, the address must answer with one of them.
  if [ -z "$UPDATE" ] || [ ! -e "$DIR/ssh/known_hosts" ]; then
    scanned=$(scan_host "$IP" "$SSH_PORT" -H) || fail "No SSH server answers on $IP port $SSH_PORT."
    own=$(cat /etc/ssh/ssh_host_*_key.pub 2>/dev/null | awk '{ print $2 }')
    if [ -n "$own" ]; then
      printf '%s\n' "$scanned" | awk '{ print $3 }' | grep -qxF "$own" ||
        fail "$IP answers with another server's SSH key. Is $IP really this server's address?"
    fi
    printf '%s\n' "$scanned" > "$DIR/ssh/known_hosts"
    chmod 600 "$DIR/ssh/known_hosts" "$key" 2>/dev/null || true
    ok "This server's SSH identity recorded"
  fi

  # The connection the dashboard makes, tried before the container relies on it.
  [ -r "$key" ] || return 0
  if ! output=$(ssh -n -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o UserKnownHostsFile="$DIR/ssh/known_hosts" -i "$key" -p "$SSH_PORT" "$USER_NAME@$IP" true 2>&1); then
    fail "The SSH server refused the dashboard's key: $(printf '%s' "$output" | tail -n 1). Check that it allows signing in with a key (PubkeyAuthentication) for $USER_NAME."
  fi
  ok "The dashboard's key signs in over SSH"
}

start_dashboard() {
  if [ -n "$CHOWN" ]; then
    sudo chown -R "$CONTAINER_UID:$CONTAINER_UID" "$DIR/data" "$DIR/ssh" < /dev/null || fail "The folders could not be handed to the container."
  fi
  say ""
  if [ -n "$CHECKOUT" ]; then say "${BOLD}Building and starting the dashboard${RESET} (building takes a few minutes)"
  else say "${BOLD}Starting the dashboard${RESET} (the first start downloads its image)"
  fi
  cd "$DIR"
  PROFILE=''
  [ "$HTTPS" != yes ] || PROFILE='--profile https'
  # DOCKER is "docker" or "sudo docker", and PROFILE two words, so they are split on purpose.
  # shellcheck disable=SC2086
  $DOCKER compose $PROFILE up -d ${CHECKOUT:+--build} < /dev/null || fail "Docker could not start the dashboard. If it says \"cannot assign requested address\", LAN_IP in $DIR/.env is not an address of this server."
  # HTTPS turned off: its service stops.
  # shellcheck disable=SC2086
  [ "$HTTPS" = yes ] || [ -z "${HTTPS_WAS:-}" ] || $DOCKER compose --profile https rm -sf https < /dev/null >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  container=$($DOCKER compose ps -q dashboard < /dev/null)
  waited=0
  while :; do
    # shellcheck disable=SC2086
    state=$($DOCKER inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" < /dev/null 2>/dev/null || echo gone)
    case $state in
      "running healthy") break ;;
      *unhealthy*|exited*|dead*|gone|restarting*)
        # shellcheck disable=SC2086
        $DOCKER compose logs --tail 30 dashboard < /dev/null >&2 || true
        fail "The dashboard did not start; the end of its log is above." ;;
    esac
    [ "$waited" -lt 120 ] || fail "The dashboard did not report healthy within two minutes. Its log: cd $DIR && $DOCKER compose logs dashboard"
    sleep 2
    waited=$((waited + 2))
  done
  ok "The dashboard is running"
  # The same connection again, from inside the container, as setup will make it.
  # shellcheck disable=SC2086
  if output=$($DOCKER compose exec -T dashboard ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -i /run/ssh/id_ed25519 -p "$SSH_PORT" -o UserKnownHostsFile=/run/ssh/known_hosts "$USER_NAME@$IP" true < /dev/null 2>&1); then
    ok "The container reaches this server over SSH"
  else
    note "The container cannot sign in to $USER_NAME@$IP over SSH yet: $(printf '%s' "$output" | tail -n 1)"
    note "A firewall may keep the container from port $SSH_PORT: allow it from Docker's networks (172.16.0.0/12). See \"Setup says the server connection could not be verified\" in $GUIDE"
  fi
  [ "$HTTPS" = yes ] || return 0
  # Caddy creates its certificate in a moment.
  waited=0
  until https_answers; do
    if [ "$waited" -ge 20 ]; then
      note "HTTPS does not answer on https://$IP:8444 yet. Its log: cd $DIR && $DOCKER compose --profile https logs https"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  ok "HTTPS answers on https://$IP:8444"
}
https_answers() {
  if have curl; then curl -fsk --max-time 5 "https://$IP:8444/api/health" >/dev/null 2>&1
  elif have wget; then wget -q --no-check-certificate -T 5 -O /dev/null "https://$IP:8444/api/health" 2>/dev/null
  else return 0
  fi
}

report() {
  # shellcheck disable=SC2086
  token=$($DOCKER compose logs dashboard < /dev/null 2>/dev/null | sed -n 's/.*Initial setup token: \([A-Za-z0-9_-]*\).*/\1/p' | tail -n 1)
  if [ "$HTTPS" = yes ]; then address="https://$IP:8444"; else address="http://$IP:8443"; fi
  say ""
  if [ -n "$token" ]; then
    say "${GREEN}${BOLD}Linux Server Control is installed.${RESET}"
    say ""
    say "  Open         ${BOLD}$address${RESET}"
    say "  Setup token  ${BOLD}$token${RESET}"
    say ""
    say "Enter the token, choose a username and a password of at least 12 characters,"
    say "and keep the connection fields as they are: they are filled in already."
  else
    say "${GREEN}${BOLD}Linux Server Control is up to date and running${RESET} at ${BOLD}$address${RESET}"
  fi
  if [ "$HTTPS" = yes ]; then
    say ""
    say "Sign in on $address only: over HTTPS the browser keeps the sign-in, and"
    say "http://$IP:8443 no longer signs in. The browser warns about the certificate"
    say "until the device trusts it: open Settings → HTTPS certificate (or \"Save the"
    say "password in this browser\" on the sign-in page) and follow the steps for the"
    say "device, once on each. Then the warning is gone and the browser saves the password."
  fi
  still=''
  for tool in python3 file crontab; do have "$tool" || still="$still $tool"; done
  [ -z "$still" ] || note "Not installed:$still. Settings → Server connection → Check server requirements says what each page needs."
  [ -z "${JOINED_DOCKER:-}" ] || note "Sign out and back in to use docker without sudo."
  say ""
  if [ -n "$CHECKOUT" ]; then say "The dashboard runs from the source code in $DIR. To update it: git pull, then run this again."
  else say "The dashboard's files are in $DIR. To update it, run the same command again."
  fi
  [ "$HTTPS" = yes ] || say "To serve it over HTTPS as well (saved passwords, the app on phones), run it again with LSC_HTTPS=yes before sh."
}

main() {
  case ${1:-} in
    -h|--help) say "$USAGE"; return 0 ;;
    '') ;;
    *) say "$USAGE" >&2; return 64 ;;
  esac
  [ "$(id -u)" != 0 ] || fail "Run this as the account you administer the server with, not as root; it uses sudo where it must."
  [ "$(uname -s)" = Linux ] || fail "Linux Server Control manages Linux servers only."
  USER_NAME=$(id -un)
  case $USER_NAME in ''|*[!A-Za-z0-9._-]*) fail "The user name $USER_NAME is not supported." ;; esac
  HOME=${HOME:?HOME is not set}
  DIR=${LSC_DIR:-$HOME/linux-server-control}
  case $DIR in /*) ;; *) fail "LSC_DIR must be an absolute folder." ;; esac
  if [ -z "${LSC_DIR:-}" ] && [ ! -f "$DIR/.env" ]; then
    found=$(installed_elsewhere)
    if [ -n "$found" ] && [ -f "$found/.env" ]; then
      DIR=$found
      say "Found the dashboard installed in $DIR"
    fi
  fi
  UPDATE=''
  [ ! -f "$DIR/.env" ] || UPDATE=1
  # A copy of the source code (a clone) builds the dashboard itself.
  CHECKOUT=''
  [ ! -f "$DIR/Dockerfile" ] || [ ! -f "$DIR/package.json" ] || CHECKOUT=1

  if [ -n "$UPDATE" ]; then
    say "${BOLD}Updating Linux Server Control${RESET} in $DIR"
    # An installation keeps its settings; only what this needs is read from them.
    IP=$(env_value "$DIR/.env" SSH_TARGET | sed 's/.*@//')
    SSH_PORT=$(env_value "$DIR/.env" SSH_PORT)
    SSH_PORT=${SSH_PORT:-22}
    # An update keeps HTTPS as it is, unless LSC_HTTPS says otherwise.
    HTTPS_WAS=''
    [ "$(env_value "$DIR/.env" COOKIE_SECURE)" != true ] || HTTPS_WAS=1
    if [ -n "${LSC_HTTPS:-}" ]; then HTTPS=$(yes_no "$LSC_HTTPS")
    elif [ -n "$HTTPS_WAS" ]; then HTTPS=yes
    else HTTPS=no
    fi
  else
    say "${BOLD}Installing Linux Server Control${RESET} in $DIR, for $USER_NAME"
    SSH_PORT=${LSC_SSH_PORT:-$(detect_ssh_port)}
  fi
  case $SSH_PORT in ''|*[!0-9]*) fail "The SSH port must be a number." ;; esac
  say ""

  check_requirements
  run_plan
  install_optional
  [ -n "$UPDATE" ] || choose_settings
  say ""
  say "${BOLD}Preparing $DIR${RESET}"
  prepare_files
  prepare_ssh
  start_dashboard
  report
}

# The whole script is read before anything runs, so a download that breaks
# off half way runs nothing.
main "$@"
