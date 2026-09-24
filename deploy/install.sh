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
# no timer, because a person releases it. On either channel it removes the pull
# agent and the nightly job line the Ansible release installed. It touches no
# channel data and no secret, and running it again installs the same files
# again.
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

# The timers are held while the files change, and whatever is still installed
# is started again however this ends.
systemctl stop agentify-release.timer "agentify-pull@$channel.timer" 2>/dev/null || true
# errexit reaches into the trap, so a unit that is gone must not decide how the
# script ends: every start in it is allowed to fail.
trap 'systemctl start "agentify-pull@$channel.timer" 2>/dev/null || true; [[ $channel != test ]] || systemctl start agentify-release.timer 2>/dev/null || true' EXIT
for unit in agentify-release.service "agentify-pull@$channel.service"; do
  case "$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || true)" in
    activating | deactivating | reloading) refuse "$unit is releasing right now; run this again when it has finished." ;;
  esac
done

install -m 755 "$root/deploy/agentify-release" /usr/local/sbin/agentify-release
install -d -m 755 /etc/agentify
install -m 644 /dev/stdin /etc/agentify/release.json <<JSON
{"channel": "$channel", "repository": "https://github.com/nuanu-ai/agentify.git"}
JSON

# The Ansible release's pull agent. Its records in /var/lib/agentify-pull-agent stay.
systemctl disable "agentify-pull@$channel.timer" 2>/dev/null || true
rm -f /etc/systemd/system/agentify-pull@.service /etc/systemd/system/agentify-pull@.timer /etc/needrestart/conf.d/agentify-pull.conf
rm -rf /opt/agentify-pull-agent /etc/agentify-pull-agent

# The Ansible release's nightly privacy job ran without the release lock; the
# first release by the command writes its own line in the same file.
if grep -qs 'scanner-jobs.sh' /etc/cron.d/agentify-release; then rm -f /etc/cron.d/agentify-release; fi

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
