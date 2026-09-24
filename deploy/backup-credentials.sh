#!/usr/bin/env bash
# Writes the S3 key of this host's backups into /etc/agentify/backup.env, and on
# a host that has no such file yet the repository's password as well, without
# any of them reaching a screen. deploy/install.sh installs it as
# /usr/local/sbin/agentify-backup-credentials; on a new host, where install.sh
# refuses until the file exists, it runs from a checkout of main as
# deploy/backup-credentials.sh:
#
#   sudo agentify-backup-credentials               asks for each value and shows nothing typed or pasted
#   ... | sudo agentify-backup-credentials --stdin  reads the values as lines, in the same order
#
# The values are the access key, the secret key and, when the file holds no
# password yet, the repository's password. deploy/README.md, "Backups", says
# how they get from the Hetzner console and from 1Password through the Mac's
# clipboard into it. A secret pasted at a prompt that echoes lands on the
# screen and in whatever records the screen, which is how the bucket's first
# key leaked, so every prompt here reads with read -s, and no value is printed
# or passed to a command as an argument.
#
# The file is written only once restic has opened the repository with the new
# values, and then whole: beside the old one, root's with mode 600, renamed
# over it. Everything else it held stays.
set -euo pipefail
umask 077

file=/etc/agentify/backup.env
refuse() { echo "backup-credentials: $*" >&2; exit 1; }
case "${1:-}" in
  "") from=terminal ;;
  --stdin) from=stdin ;;
  *) refuse "usage: agentify-backup-credentials [--stdin]" ;;
esac
[[ $EUID -eq 0 ]] || refuse "$file is root's; run this with sudo."
if [[ -f /etc/agentify/release.json ]] \
  && [[ $(python3 -c 'import json; print(json.load(open("/etc/agentify/release.json"))["channel"])') == test ]]; then
  refuse "TEST takes no backups, since its data is test data."
fi
if [[ $from == terminal ]] && ! { : < /dev/tty; } 2> /dev/null; then
  refuse "there is no terminal to ask on; pipe the values in with --stdin."
fi

# The bucket PRODUCTION's backups live in, for a host whose file does not name one yet.
RESTIC_REPOSITORY=s3:https://fsn1.your-objectstorage.com/nuanu-agentify-backups AWS_DEFAULT_REGION=fsn1 RESTIC_PASSWORD=""
if [[ -e $file ]]; then
  [[ $(stat -c '%U %a' "$file") == "root 600" ]] || refuse "$file is not root's with mode 600, so it is not read; nothing was changed."
  # shellcheck source=/dev/null
  . "$file"
fi

# Reads one value into the named variable, trimmed of the blanks a copy can
# carry. A key holds no blank inside, so one that does was not copied whole.
value() {
  local line=""
  if [[ $from == terminal ]]; then
    IFS= read -rs -p "${2^} (nothing is shown): " line < /dev/tty || true
    echo > /dev/tty
  else
    IFS= read -r line || true
  fi
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -n $line ]] || refuse "$2 is empty, so nothing was changed."
  [[ $3 == any || $line != *[[:space:]]* ]] || refuse "$2 holds a blank, so it was not copied whole; nothing was changed."
  printf -v "$1" '%s' "$line"
}
value AWS_ACCESS_KEY_ID "the access key" key
value AWS_SECRET_ACCESS_KEY "the secret key" key
[[ -n $RESTIC_PASSWORD ]] || value RESTIC_PASSWORD "the repository's password" any
[[ $AWS_ACCESS_KEY_ID != "$AWS_SECRET_ACCESS_KEY" ]] \
  || refuse "the access key and the secret key are the same value, so one of them was not copied; nothing was changed."

export RESTIC_REPOSITORY AWS_DEFAULT_REGION RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
restic cat config > /dev/null || refuse "the repository did not open with these values, for the reason above; $file is as it was."
for name in RESTIC_REPOSITORY AWS_DEFAULT_REGION RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  printf '%s=%q\n' "$name" "${!name}"
done > "$file.new"
chmod 600 "$file.new"
mv "$file.new" "$file"
echo "backup-credentials: $file holds the access key ${AWS_ACCESS_KEY_ID:0:4}..., and the repository opens with it."
