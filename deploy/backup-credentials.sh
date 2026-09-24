#!/usr/bin/env bash
# Writes the S3 key of PRODUCTION's backups into /etc/agentify/backup.env
# without it reaching a screen: asked at prompts that show nothing, or read as
# two lines from stdin with --stdin (deploy/README.md, "Backups"). A secret
# pasted at a prompt that echoes lands on the screen, which is how the bucket's
# first key leaked. The rest of the file stays; the file is replaced whole,
# root's with mode 600.
set -euo pipefail
umask 077
file=/etc/agentify/backup.env
if [[ ${1:-} == --stdin ]]; then
  read -r key && read -r secret
else
  read -rs -p "Access key (nothing is shown): " key < /dev/tty && echo
  read -rs -p "Secret key (nothing is shown): " secret < /dev/tty && echo
fi
[[ -n $key && -n $secret && $key != "$secret" ]] || { echo "backup-credentials: two different values are needed; nothing was changed." >&2; exit 1; }
{ grep -v -e '^AWS_ACCESS_KEY_ID=' -e '^AWS_SECRET_ACCESS_KEY=' "$file" 2> /dev/null || true; printf 'AWS_ACCESS_KEY_ID=%q\nAWS_SECRET_ACCESS_KEY=%q\n' "$key" "$secret"; } > "$file.new"
chmod 600 "$file.new"
mv "$file.new" "$file"
echo "backup-credentials: $file holds the access key ${key:0:4}..."
