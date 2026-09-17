#!/usr/bin/env python3
"""Prepare credentials for a stopped, one-off import; never give them to a service.

Ansible calls this under no_log. Values come from Compose's private resolved
configuration so dotenv escaping is interpreted once, by Compose itself.
"""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit


def private_database_url(value, database):
    parsed = urlsplit(value)
    if parsed.scheme not in ('postgres', 'postgresql') or parsed.path != '/' + database:
        raise ValueError('Unexpected import database')
    if not parsed.username or not parsed.password or parsed.fragment:
        raise ValueError('Incomplete import database configuration')
    # The stopped migration container joins only this channel private bridge.
    # Preserve escaped credentials and options; never forward a public host.
    credentials = parsed.netloc.rsplit('@', 1)[0]
    return urlunsplit((parsed.scheme, credentials + '@agentify-scanner-postgres:5432', parsed.path, parsed.query, ''))


def main():
    directory = Path(sys.argv[1])
    commerce = json.loads((directory / 'commerce-resolved.json').read_text())['services']
    scanner = json.loads((directory / 'scanner-resolved.json').read_text())['services']
    web = scanner['web']['environment']
    values = {
        'CABINET_DATABASE_URL': private_database_url(commerce['migrate']['environment']['DATABASE_URL'], 'agentify_commerce'),
        'SCANNER_DATABASE_URL': private_database_url(scanner['migrate']['environment']['DATABASE_URL'], 'agentify_scanner'),
        'EMAIL_ENCRYPTION_KEY': web['EMAIL_ENCRYPTION_KEY'],
        'TOKEN_HMAC_SECRET': web['TOKEN_HMAC_SECRET'],
    }
    if any(not isinstance(v, str) or not v or '\n' in v or '\r' in v or '\0' in v for v in values.values()):
        raise ValueError('Invalid private import configuration')
    path = directory / 'recovery' / 'identity-cutover.env'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        # docker run --env-file uses literal values, not Compose dotenv syntax.
        stream.write(''.join(k + '=' + v + '\n' for k, v in values.items()))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('Identity cutover environment preparation failed\n')
        sys.exit(1)
