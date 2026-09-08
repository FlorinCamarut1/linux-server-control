#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo."
  exit 1
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dashboard_ssh_user=${1:-${SUDO_USER:-}}
case "$dashboard_ssh_user" in
  ""|*[!a-zA-Z0-9_-]*)
    echo "Usage: sudo $0 SSH_USER"
    exit 64
    ;;
esac
install -m 0755 "$project_dir/scripts/media-dashboard-root-cron" /usr/local/sbin/media-dashboard-root-cron
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/media-dashboard-root-cron list, /usr/local/sbin/media-dashboard-root-cron install, /usr/local/sbin/media-dashboard-root-cron system-list\n' "$dashboard_ssh_user" > /etc/sudoers.d/media-dashboard-root-cron
chmod 0440 /etc/sudoers.d/media-dashboard-root-cron
visudo -cf /etc/sudoers.d/media-dashboard-root-cron
echo "Root cron access enabled."
