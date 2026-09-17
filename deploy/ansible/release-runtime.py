#!/usr/bin/env python3
"""Read-only release evidence. Never emit container environments or credentials."""
import json
from pathlib import Path
import subprocess
import sys

mode, directory, channel_name = sys.argv[1:4]
root = Path(directory)
channel = json.loads(sys.argv[4])
manifest = json.loads((root / 'release-manifest.json').read_text())
configs = {s: json.loads((root / (s + '-resolved.json')).read_text()) for s in ['commerce', 'scanner']}


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


SCANNER_POLICY_KEYS = {
    'web': [
        'EMAIL_PROVIDER', 'REGISTRATION_ENABLED', 'SCAN_ACCEPTANCE_ENABLED',
        'TURNSTILE_ENFORCED', 'SCANNER_CACHE_ENABLED', 'BENCHMARK_ENABLED',
        'PUBLIC_SHARE_ENABLED', 'PARTNER_POSTBACK_ENABLED', 'APIFY_BROWSER_MODE',
        'REMEDIATION_PROMPT_ENABLED', 'CARD_SIGNAL_ENABLED',
        'ANALYTICS_RUNTIME_ENV', 'ANALYTICS_SERVER_DELIVERY_ENABLED',
    ],
    'worker': [
        'SCANNER_CACHE_ENABLED', 'ANALYTICS_ENV', 'ANALYTICS_RUNTIME_ENV',
        'ANALYTICS_SERVER_DELIVERY_ENABLED', 'POSTHOG_ENABLED',
        'META_CAPI_ENABLED', 'PARTNER_POSTBACK_ENABLED',
        'APIFY_BROWSER_ENABLED', 'APIFY_BROWSER_MODE',
    ],
    'privacy-cleanup': [
        'EMAIL_PROVIDER', 'REGISTRATION_ENABLED', 'CARD_SIGNAL_ENABLED',
    ],
}

TEST_SCANNER_POLICY = {
    'web': {
        'EMAIL_PROVIDER': 'resend',
        'REGISTRATION_ENABLED': 'true',
        'SCAN_ACCEPTANCE_ENABLED': 'true',
        'TURNSTILE_ENFORCED': 'false',
        'SCANNER_CACHE_ENABLED': 'false',
        'BENCHMARK_ENABLED': 'false',
        'PUBLIC_SHARE_ENABLED': 'false',
        'PARTNER_POSTBACK_ENABLED': 'false',
        'APIFY_BROWSER_MODE': 'off',
        'REMEDIATION_PROMPT_ENABLED': 'true',
        'CARD_SIGNAL_ENABLED': 'false',
        'ANALYTICS_RUNTIME_ENV': 'test',
        'ANALYTICS_SERVER_DELIVERY_ENABLED': 'false',
    },
    'worker': {
        'SCANNER_CACHE_ENABLED': 'false',
        'ANALYTICS_ENV': 'test',
        'ANALYTICS_RUNTIME_ENV': 'test',
        'ANALYTICS_SERVER_DELIVERY_ENABLED': 'false',
        'POSTHOG_ENABLED': 'false',
        'META_CAPI_ENABLED': 'false',
        'PARTNER_POSTBACK_ENABLED': 'false',
        'APIFY_BROWSER_ENABLED': 'false',
        'APIFY_BROWSER_MODE': 'off',
    },
    'privacy-cleanup': {
        'EMAIL_PROVIDER': 'disabled',
        'REGISTRATION_ENABLED': 'false',
        'CARD_SIGNAL_ENABLED': 'false',
    },
}


def selected_scanner_policy(config):
    selected = {}
    for role, keys in SCANNER_POLICY_KEYS.items():
        environment = config['services'][role].get('environment', {})
        selected[role] = {}
        for key in keys:
            require(key in environment, role + ' omits scanner policy ' + key)
            selected[role][key] = str(environment[key])
    return selected


scanner_policy = selected_scanner_policy(configs['scanner'])
if channel_name == 'test':
    require(scanner_policy == TEST_SCANNER_POLICY, 'Test scanner policy differs from the reviewed safe policy')
elif mode == 'topology':
    # Production authentication and provider policy is existing operator-owned
    # state. Preserve the running values without printing or guessing them.
    for role in ['web', 'worker']:
        name = channel['scanner_project'] + '-' + role + '-1'
        container = inspect('container', name)
        require(container['State']['Running'], name + ' is not running for policy custody')
        current = dict(line.split('=', 1) for line in container['Config']['Env'] if '=' in line)
        for key, value in scanner_policy[role].items():
            require(current.get(key) == value, role + ' changes production scanner policy: ' + key)
require(
    scanner_policy['privacy-cleanup'] == TEST_SCANNER_POLICY['privacy-cleanup'],
    'Privacy cleanup policy differs from its non-interactive boundary',
)


normalized = {}
for surface, config in configs.items():
    normalized[surface] = {}
    for role, service in config['services'].items():
        normalized[surface][role] = {key: service[key] for key in ['image', 'command', 'build'] if key in service}
        require('build' not in service, surface + '.' + role + ' still has a build definition')
        if surface == 'scanner':
            require(not service.get('ports'), 'Scanner services must not publish host ports')
            env = service.get('environment', {})
            if role in ['web', 'worker', 'privacy-cleanup']:
                require(env.get('APP_BASE_URL') == channel['origin'], role + ' uses the wrong scanner origin')
            for key in ['DATABASE_URL', 'ADMIN_DATABASE_URL', 'WEB_DATABASE_URL', 'WORKER_DATABASE_URL', 'PRIVACY_DATABASE_URL', 'DASHBOARD_DATABASE_URL']:
                if env.get(key):
                    require(env[key].endswith('@agentify-scanner-postgres:5432/agentify_scanner'), role + ' uses a database outside its private scanner network')
    if surface == 'commerce':
        require(config['volumes']['agentify-postgres']['name'] == channel['postgres_volume'], 'Commerce data volume differs from the retained channel volume')
        require(config['volumes']['agentify-caddy']['name'] == channel['caddy_volume'], 'Commerce certificate volume differs')
    require(config['networks']['agentify-scanner-db']['name'] == channel['database_network'], 'Wrong scanner database network')
    require(config['networks']['agentify-ingress']['name'] == channel['ingress_network'], 'Wrong channel ingress network')

if mode == 'topology':
    normalized['scannerPolicy'] = scanner_policy
    (root / 'topology.json').write_text(json.dumps(normalized, indent=2) + '\n')
    print('Rendered image, command, origin, volume and private-network topology captured')
elif mode == 'verify':
    services = {'commerce': ['postgres', 'gateway', 'cabinet', 'web'], 'scanner': ['web', 'worker']}
    evidence = {'revision': manifest['revision'], 'channel': channel_name, 'services': []}
    for surface, roles in services.items():
        for role in roles:
            config = configs[surface]['services'][role]
            name = channel[surface + '_project'] + '-' + role + '-1'
            container = inspect('container', name)
            image = inspect('image', config['image'])
            require(container['State']['Running'], name + ' is not running')
            require(container['State'].get('Health', {}).get('Status', 'healthy') == 'healthy', name + ' is unhealthy')
            require(container['Config']['Image'] == config['image'], name + ' does not name its manifest digest')
            require(container['Image'] == image['Id'], name + ' does not run the exact loaded image')
            if surface != 'commerce' or role != 'postgres':
                require(image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == manifest['revision'], name + ' was built from another revision')
            env = dict(line.split('=', 1) for line in container['Config']['Env'] if '=' in line)
            for key, value in config.get('environment', {}).items():
                require(env.get(key) == str(value), name + ' environment mismatch: ' + key)
            evidence['services'].append({'name': name, 'image': config['image'], 'imageId': container['Image'], 'containerId': container['Id']})
    # Scheduled and migration services have no resident container. Their exact
    # image availability and source labels are still part of release evidence.
    for role, ref in manifest['images']['firstParty'].items():
        image = inspect('image', ref)
        require(image['Config'].get('Labels', {}).get('org.opencontainers.image.revision') == manifest['revision'], role + ' job image revision differs')
    print(json.dumps(evidence, indent=2))
else:
    raise RuntimeError('Expected topology or verify')
