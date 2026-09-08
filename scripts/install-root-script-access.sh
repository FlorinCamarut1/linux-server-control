#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo."
  exit 1
fi

dashboard_ssh_user=${1-}
shift || true
case "$dashboard_ssh_user" in
  ""|*[!a-zA-Z0-9_-]*)
    echo "Usage: sudo $0 SSH_USER ALLOWED_SCRIPT_DIRECTORY..."
    exit 64
    ;;
esac
[ "$#" -gt 0 ] || { echo "Provide at least one allowed script directory."; exit 64; }

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install -m 0755 "$project_dir/scripts/media-dashboard-root-run" /usr/local/sbin/media-dashboard-root-run
install -d -m 0755 /etc/media-dashboard
: > /etc/media-dashboard/root-script-paths
for requested in "$@"; do
  root_path=$(realpath -e -- "$requested")
  [ -d "$root_path" ] || { echo "Not a directory: $requested"; exit 64; }
  printf '%s\n' "$root_path" >> /etc/media-dashboard/root-script-paths
done
chmod 0644 /etc/media-dashboard/root-script-paths
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/media-dashboard-root-run status, /usr/local/sbin/media-dashboard-root-run run *\n' "$dashboard_ssh_user" > /etc/sudoers.d/media-dashboard-root-run
chmod 0440 /etc/sudoers.d/media-dashboard-root-run
visudo -cf /etc/sudoers.d/media-dashboard-root-run
echo "Root script access enabled."
