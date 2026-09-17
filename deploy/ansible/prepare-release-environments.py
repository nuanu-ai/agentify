#!/usr/bin/env python3
"""Preserve host-owned configuration while assigning an immutable release.

Called only by release-stage.yml under Ansible no_log. Never print values or
copy production data/secrets into test. Re-running a staged release preserves
its generated test secrets, so staging is not an implicit credential rotation.
"""
import base64
from email.utils import parseaddr
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

channel = json.loads(sys.argv[1])
channel_name, directory = sys.argv[2], Path(sys.argv[3])
manifest = json.loads((directory / 'release-manifest.json').read_text())
stable = Path('/home/dmitry/agentify-configuration')
stable.mkdir(mode=0o700, exist_ok=True)


def environment(container):
    data = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
    return dict(line.split('=', 1) for line in data['Config']['Env'] if '=' in line)


def write_environment(name, source, overrides, base=directory):
    destination = base / name
    # The original snapshot is immutable after the first stage. This also
    # preserves fresh test credentials on a second stage of the same release.
    old = destination.read_text() if destination.exists() else source
    keys = set(overrides)
    lines = [line for line in old.splitlines() if line.partition('=')[0].strip() not in keys]
    for key, value in overrides.items():
        assert '\n' not in value and '\r' not in value
        # Compose dotenv single quotes preserve literal dollar signs in bcrypt.
        lines.append(key + "='" + value.replace("'", "\\'") + "'")
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write('\n'.join(lines) + '\n')


fp, infra = manifest['images']['firstParty'], manifest['images']['infrastructure']
common = {
    'AGENTIFY_POSTGRES_IMAGE': infra['postgres'],
    'AGENTIFY_ALPINE_IMAGE': infra['alpine'],
    'AGENTIFY_EDGE_IMAGE': infra['caddy'],
    'AGENTIFY_INGRESS_NETWORK': channel['ingress_network'],
    'AGENTIFY_SCANNER_DB_NETWORK': channel['database_network'],
}
stable_commerce = stable / 'commerce.env'
if not stable_commerce.exists():
    write_environment('commerce.env', Path(channel['commerce_environment']).read_text(), {}, stable)

if channel_name == 'production':
    edge = environment(channel['edge_container'])
    admin = {key: edge[key] for key in ['ADMIN_BASIC_AUTH_USER', 'ADMIN_BASIC_AUTH_HASH']}
    if not (stable / 'scanner.env').exists():
        write_environment('scanner.env', Path(channel['scanner_environment']).read_text(), {}, stable)
    scanner_source = (stable / 'scanner.env').read_text()
    # Ask Compose to parse its own dotenv syntax, including quoted values.
    # Project only the explicitly public settings, never a server API key.
    public_names = {
        'TURNSTILE_SITE_KEY': 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
        'PRIVACY_EMAIL': 'NEXT_PUBLIC_PRIVACY_EMAIL',
        'ABUSE_EMAIL': 'NEXT_PUBLIC_ABUSE_EMAIL',
        'LEGAL_OPERATOR': 'NEXT_PUBLIC_LEGAL_OPERATOR',
        'LEGAL_IDENTITY_CONFIRMED': 'NEXT_PUBLIC_LEGAL_IDENTITY_CONFIRMED',
        'STRIPE_PUBLISHABLE_KEY': 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
        'ANALYTICS_RUNTIME_ENV': 'NEXT_PUBLIC_ANALYTICS_ENV',
        'POSTHOG_BROWSER_KEY': 'NEXT_PUBLIC_POSTHOG_KEY',
        'POSTHOG_BROWSER_HOST': 'NEXT_PUBLIC_POSTHOG_HOST',
        'POSTHOG_DESTINATION_ENV': 'NEXT_PUBLIC_POSTHOG_DESTINATION_ENV',
        'META_PIXEL_ID': 'NEXT_PUBLIC_META_PIXEL_ID',
        'META_DESTINATION_ENV': 'NEXT_PUBLIC_META_DESTINATION_ENV',
    }
    projection = directory / '.public-env-projection.json'
    projection.write_text(json.dumps({'services': {'projection': {'image': infra['alpine'], 'environment': {
        key: '${' + key + ':-${' + legacy + ':-}}' for key, legacy in public_names.items()
    }}}}))
    try:
        parsed = json.loads(subprocess.check_output(['docker', 'compose', '--env-file', str(stable / 'scanner.env'), '-f', str(projection), 'config', '--format', 'json']))
        scanner_overrides = {key: value for key, value in parsed['services']['projection']['environment'].items() if value != ''}
    finally:
        projection.unlink()
else:
    admin_file = stable / 'scanner-admin.json'
    if admin_file.exists():
        admin = json.loads(admin_file.read_text())
    else:
        password = secrets.token_urlsafe(36)
        hashed = subprocess.check_output(['docker', 'run', '--rm', '--network', 'none', infra['caddy'], 'caddy', 'hash-password', '--plaintext', password], text=True).strip()
        admin = {'ADMIN_BASIC_AUTH_USER': 'agentify-test', 'ADMIN_BASIC_AUTH_HASH': hashed}
        fd = os.open(admin_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(admin, out)
        fd = os.open(stable / 'scanner-admin-password', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(password + '\n')
    scanner_source = ''
    scanner_overrides = {}
    if not (stable / 'scanner.env').exists():
        exists = subprocess.check_output(['docker', 'exec', channel['postgres_container'], 'psql', '-U', 'agentify_commerce', '-d', 'agentify_commerce', '-At', '-v', 'ON_ERROR_STOP=1', '-c', "select count(*) from pg_database where datname='agentify_scanner'"], text=True).strip()
        if exists != '0':
            raise RuntimeError('Scanner database exists without stable secrets; restore its configuration, never generate replacement identity keys')
        postgres = environment(channel['postgres_container'])
        cabinet = environment(channel['cabinet_container'])
        # Use the provider already configured for this test cabinet, never
        # fetch a production provider credential to make test work.
        if not cabinet.get('MAIL_API_KEY') or cabinet.get('MAIL_URL') != 'https://api.resend.com':
            raise RuntimeError('The test cabinet needs its own configured Resend provider before scanner registration can be accepted')
        scanner_overrides = {
            'DATABASE_MODE': 'private',
            'POSTGRES_ADMIN_PASSWORD': postgres['POSTGRES_PASSWORD'],
            'ADMIN_DATABASE_URL': 'postgresql://agentify_commerce:' + postgres['POSTGRES_PASSWORD'] + '@agentify-scanner-postgres:5432/agentify_scanner',
            'TOKEN_HMAC_SECRET': secrets.token_hex(32),
            'EMAIL_ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode(),
            'REGISTRATION_ENABLED': 'true',
            'SCAN_ACCEPTANCE_ENABLED': 'true',
            'EMAIL_PROVIDER': 'resend',
            'RESEND_API_KEY': cabinet['MAIL_API_KEY'],
            'RESEND_FROM': parseaddr(cabinet['MAIL_FROM'])[1],
            'TURNSTILE_ENFORCED': 'false',
            'TURNSTILE_SITE_KEY': '',
            'APIFY_BROWSER_ENABLED': 'false',
            'APIFY_BROWSER_MODE': 'off',
            'SCANNER_CONCURRENCY': '2',
            'ANALYTICS_RUNTIME_ENV': 'test',
        }
        for role in ['WEB', 'WORKER', 'PRIVACY', 'DASHBOARD']:
            password = secrets.token_hex(24)
            scanner_overrides['POSTGRES_' + role + '_PASSWORD'] = password
            scanner_overrides[role + '_DATABASE_URL'] = 'postgresql://agentify_' + role.lower() + ':' + password + '@agentify-scanner-postgres:5432/agentify_scanner'
        write_environment('scanner.env', '', scanner_overrides, stable)
    scanner_source = (stable / 'scanner.env').read_text()
    scanner_overrides = {}

write_environment('commerce.env', stable_commerce.read_text(), {
    **common, **admin,
    'AGENTIFY_APP_IMAGE': fp['commerce-app'], 'AGENTIFY_WEB_IMAGE': fp['commerce-web'],
    'AGENTIFY_PUBLIC_ORIGIN': channel['origin'],
})
write_environment('scanner.env', scanner_source, {
    **common, **admin, **scanner_overrides,
    'APP_BASE_URL': channel['origin'],
    'AGENTIFY_SCANNER_WEB_IMAGE': fp['scanner-web'],
    'AGENTIFY_SCANNER_WORKER_IMAGE': fp['scanner-worker'],
    'AGENTIFY_SCANNER_PRIVACY_IMAGE': fp['scanner-privacy'],
    'AGENTIFY_BACKUP_DIRECTORY': channel['backup_directory'],
    'RECONCILE_RUNTIME_ROLE_PASSWORDS': 'false',
    'ROLE_PASSWORD_ROTATION_MAINTENANCE_ACK': 'false',
})
