#!/usr/bin/env python3
"""Read-only release evidence. Never emit container environments or credentials."""
import json
from pathlib import Path
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def compose_runtime_value(value):
    """Decode Compose config JSON's escaped dollars to the container value."""
    return str(value).replace('$$', '$')


EXPECTED_ROLES = {
    'postgres', 'migrate', 'gateway', 'cabinet', 'web',
    'scanner-migrate', 'scanner', 'scanner-worker', 'scanner-privacy',
}

SCANNER_ROLES = {'scanner-migrate', 'scanner', 'scanner-worker', 'scanner-privacy'}


def expected_images(identity):
    first_party = identity['firstParty']
    infrastructure = identity['infrastructure']
    return {
        'postgres': infrastructure['postgres'],
        'migrate': first_party['app'],
        'gateway': first_party['app'],
        'cabinet': first_party['app'],
        'web': first_party['web'],
        'scanner-migrate': first_party['scanner-worker'],
        'scanner': first_party['scanner'],
        'scanner-worker': first_party['scanner-worker'],
        'scanner-privacy': first_party['scanner-privacy'],
    }


mode = sys.argv[1]
directory, channel_name = sys.argv[2:4]
root = Path(directory)
channel = json.loads(sys.argv[4])
revision = sys.argv[5]
identity = json.loads(sys.argv[6])
config = json.loads((root / 'resolved.json').read_text())


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


SCANNER_POLICY_KEYS = {
    'scanner': [
        'REGISTRATION_ENABLED', 'SCAN_ACCEPTANCE_ENABLED',
        'TURNSTILE_ENFORCED', 'SCANNER_CACHE_ENABLED', 'BENCHMARK_ENABLED',
        'PUBLIC_SHARE_ENABLED', 'PARTNER_POSTBACK_ENABLED', 'APIFY_BROWSER_MODE',
        'REMEDIATION_PROMPT_ENABLED', 'CARD_SIGNAL_ENABLED',
        'ANALYTICS_RUNTIME_ENV', 'ANALYTICS_SERVER_DELIVERY_ENABLED',
    ],
    'scanner-worker': [
        'SCANNER_CACHE_ENABLED', 'ANALYTICS_ENV', 'ANALYTICS_RUNTIME_ENV',
        'ANALYTICS_SERVER_DELIVERY_ENABLED', 'POSTHOG_ENABLED',
        'META_CAPI_ENABLED', 'PARTNER_POSTBACK_ENABLED',
        'APIFY_BROWSER_ENABLED', 'APIFY_BROWSER_MODE',
    ],
    'scanner-privacy': [
        'REGISTRATION_ENABLED', 'CARD_SIGNAL_ENABLED',
    ],
}

TEST_SCANNER_POLICY = {
    'scanner': {
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
    'scanner-worker': {
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
    'scanner-privacy': {
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


scanner_policy = selected_scanner_policy(config)
if channel_name == 'test':
    require(scanner_policy == TEST_SCANNER_POLICY, 'Test scanner policy differs from the reviewed safe policy')
elif mode == 'topology':
    # Production authentication and provider policy is existing operator-owned
    # state. Preserve the running values without printing or guessing them.
    for role in ['scanner', 'scanner-worker']:
        name = channel['project'] + '-' + role + '-1'
        container = inspect('container', name)
        require(container['State']['Running'], name + ' is not running for policy custody')
        current = dict(line.split('=', 1) for line in container['Config']['Env'] if '=' in line)
        for key, value in scanner_policy[role].items():
            require(current.get(key) == value, role + ' changes production scanner policy: ' + key)
require(
    scanner_policy['scanner-privacy'] == TEST_SCANNER_POLICY['scanner-privacy'],
    'Privacy cleanup policy differs from its non-interactive boundary',
)


# The private identity route is a credential shared by exactly these two
# services and a listener that publishes no host port. One project means both
# are on one network, so the boundary is the credential rather than the wire:
# what this proves is that nothing else in the rendered graph is handed either
# half of it, and that neither half is a secret the cabinet already uses for
# something else.
cabinet = config['services']['cabinet']
scanner = config['services']['scanner']
cabinet_env = cabinet.get('environment', {})
scanner_env = scanner.get('environment', {})
report_secret = compose_runtime_value(cabinet_env.get('REPORT_IDENTITY_SECRET', ''))
require(len(report_secret) >= 32, 'Cabinet omits the private report identity secret')
require(report_secret == compose_runtime_value(scanner_env.get('REPORT_IDENTITY_SECRET', '')), 'Report identity peers have different credentials')
require(scanner_env.get('CABINET_IDENTITY_URL') == 'http://cabinet:3002', 'Scanner identity URL leaves this project network')
require(not cabinet.get('ports'), 'Cabinet identity listener must not publish a host port')
for role, service in config['services'].items():
    environment = service.get('environment', {})
    if role not in ['cabinet', 'scanner']:
        require('REPORT_IDENTITY_SECRET' not in environment, role + ' receives the report identity credential')
        require('CABINET_IDENTITY_URL' not in environment, role + ' receives the report identity route')
for environment, keys in [(cabinet_env, ['AUTH_SECRET', 'REGISTRATION_INVITATION']), (scanner_env, ['TOKEN_HMAC_SECRET'])]:
    for key in keys:
        require(report_secret != compose_runtime_value(environment.get(key, '')), 'Report identity must not reuse ' + key)


normalized = {}
assigned_images = expected_images(identity)
roles = config['services']
require(set(roles) == EXPECTED_ROLES, 'Service roles differ from the reviewed topology')
for role, service in roles.items():
    require('build' not in service, role + ' still has a build definition')
    require(service.get('image') == assigned_images[role], role + ' uses an unassigned image')
    # Compose emits command: null when a service inherits the image command.
    # Store null explicitly so absent and null compare as the same behavior.
    normalized[role] = {'image': service['image'], 'command': service.get('command')}
    if role in SCANNER_ROLES:
        require(not service.get('ports'), 'Scanner services must not publish host ports')
        environment = service.get('environment', {})
        if role in ['scanner', 'scanner-worker', 'scanner-privacy']:
            require(environment.get('APP_BASE_URL') == channel['origin'], role + ' uses the wrong scanner origin')
        require(
            environment.get('DATABASE_URL', '').endswith('@postgres:5432/agentify_scanner'),
            role + ' uses a database outside this project',
        )
require(config['volumes']['agentify-postgres']['name'] == channel['postgres_volume'], 'Data volume differs from the retained channel volume')
require(config['volumes']['agentify-caddy']['name'] == channel['caddy_volume'], 'Certificate volume differs')
require(config['networks']['agentify-ingress']['name'] == channel['ingress_network'], 'Wrong channel ingress network')

if mode == 'topology':
    topology = {'revision': revision, 'services': normalized, 'scannerPolicy': scanner_policy}
    (root / 'topology.json').write_text(json.dumps(topology, indent=2) + '\n')
    print('Rendered revision, image, command, origin, volume and network topology captured')
elif mode == 'verify':
    evidence = {'revision': revision, 'channel': channel_name, 'services': []}
    infrastructure = set(identity['infrastructure'].values())
    for role in ['postgres', 'gateway', 'cabinet', 'web', 'scanner', 'scanner-worker']:
        service = config['services'][role]
        name = channel['project'] + '-' + role + '-1'
        container = inspect('container', name)
        image = inspect('image', service['image'])
        require(container['State']['Running'], name + ' is not running')
        require(container['State'].get('Health', {}).get('Status', 'healthy') == 'healthy', name + ' is unhealthy')
        require(container['Config']['Image'] == service['image'], name + ' does not name its assigned image tag')
        require(container['Image'] == image['Id'], name + ' does not run the current assigned image ID')
        if service['image'] not in infrastructure:
            labels = image['Config'].get('Labels', {})
            require(labels.get('org.opencontainers.image.revision') == revision, name + ' was built from another revision')
            require(labels.get('org.opencontainers.image.source') == 'https://github.com/nuanu-ai/agentify', name + ' was built from another repository')
        environment = dict(line.split('=', 1) for line in container['Config']['Env'] if '=' in line)
        for key, value in service.get('environment', {}).items():
            require(environment.get(key) == compose_runtime_value(value), name + ' environment mismatch: ' + key)
        evidence['services'].append({'name': name, 'image': service['image'], 'imageId': container['Image'], 'containerId': container['Id']})
    # Scheduled and migration services have no resident container. Their local
    # image IDs and source labels are still part of the host's release evidence.
    evidence['firstPartyImages'] = []
    for role, reference in identity['firstParty'].items():
        image = inspect('image', reference)
        labels = image['Config'].get('Labels', {})
        require(labels.get('org.opencontainers.image.revision') == revision, role + ' job image revision differs')
        require(labels.get('org.opencontainers.image.source') == 'https://github.com/nuanu-ai/agentify', role + ' job image repository differs')
        evidence['firstPartyImages'].append({'role': role, 'image': reference, 'imageId': image['Id']})
    print(json.dumps(evidence, indent=2))
else:
    raise RuntimeError('Expected topology, compare or verify')
