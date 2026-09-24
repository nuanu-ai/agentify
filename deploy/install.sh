#!/usr/bin/env bash
# Installs agentify-release on this host, for its one channel:
#
#   sudo deploy/install.sh test|production
#
# Run it on the host from a checkout of main. On both channels it installs the
# command as /usr/local/sbin/agentify-release and writes its configuration,
# /etc/agentify/release.json, and the rule that keeps needrestart from
# restarting a release in the middle of an activation. On TEST it also installs
# and starts the timer that releases whatever deploy-test names; PRODUCTION has
# no timer, because a person releases it. It touches no channel data and no
# secret, and running it again installs the same files again.
set -euo pipefail

channel="${1:-}"
refuse() { echo "install: $*" >&2; exit 1; }
case "$channel" in test | production) ;; *) refuse "usage: sudo deploy/install.sh test|production" ;; esac
[[ $EUID -eq 0 ]] || refuse "a root command is installed by root; run it with sudo."
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
environment="/etc/agentify/$channel.env"
[[ -f $environment ]] || refuse "$environment does not exist; deploy/README.md, \"Setting up a host\", says what it holds."
[[ $(stat -c '%U %a' "$environment") == "root 600" ]] \
  || refuse "$environment holds the channel's secrets, so it belongs to root with mode 600."
for command in docker flock curl git python3; do
  command -v "$command" >/dev/null || refuse "a release needs $command, and this host has none."
done
aging="$(chage -l root)" || refuse "chage -l root did not say whether root's password must be changed."
[[ ${aging,,} != *"password must be changed"* ]] \
  || refuse "root has to change its password first: sudo refuses to switch accounts until it does, which stopped every production release on 2026-09-22."

# TEST's timer is held while the files change and started again however this
# ends. errexit reaches into the trap, so the start in it is allowed to fail.
systemctl stop agentify-release.timer 2>/dev/null || true
trap '[[ $channel != test ]] || systemctl start agentify-release.timer 2>/dev/null || true' EXIT
case "$(systemctl show -p ActiveState --value agentify-release.service 2>/dev/null || true)" in
  activating | deactivating | reloading) refuse "agentify-release.service is releasing right now; run this again when it has finished." ;;
esac

install -m 755 "$root/deploy/agentify-release" /usr/local/sbin/agentify-release
install -d -m 755 /etc/agentify
install -m 644 /dev/stdin /etc/agentify/release.json <<JSON
{"channel": "$channel", "repository": "https://github.com/nuanu-ai/agentify.git"}
JSON

if [[ $channel == test ]]; then
  install -m 644 "$root/deploy/agentify-release.service" "$root/deploy/agentify-release.timer" /etc/systemd/system/
fi
if [[ -d /etc/needrestart ]]; then
  perl -c "$root/deploy/needrestart-agentify-release.conf" 2>/dev/null
  install -d /etc/needrestart/conf.d
  install -m 644 "$root/deploy/needrestart-agentify-release.conf" /etc/needrestart/conf.d/agentify-release.conf
fi
systemctl daemon-reload
if [[ $channel == test ]]; then
  systemctl enable --now agentify-release.timer
  echo "install: TEST releases what deploy-test names within a minute; journalctl -u agentify-release.service shows it."
else
  echo "install: PRODUCTION releases when a person runs: sudo agentify-release app-v<release>"
fi
