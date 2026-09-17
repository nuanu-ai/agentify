#!/usr/bin/env python3
"""Read-only release evidence. Never emit container environments or credentials."""
import json
from pathlib import Path
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


EXPECTED_ROLES = {
    'commerce': {'postgres', 'migrate', 'gateway', 'cabinet', 'web'},
    'scanner': {
        'roles-reconcile', 'migrate', 'queue-init', 'database-dashboards-install',
        'database-access-finalize', 'web', 'worker', 'privacy-cleanup',
        'database-backup', 'database-config-check', 'database-access-verify',
    },
}


def expected_images(identity):
    first_party = identity['firstParty']
    infrastructure = identity['infrastructure']
    return {
        'commerce': {
            'postgres': infrastructure['postgres'],
            'migrate': first_party['commerce-app'],
            'gateway': first_party['commerce-app'],
            'cabinet': first_party['commerce-app'],
            'web': first_party['commerce-web'],
        },
        'scanner': {
            'roles-reconcile': infrastructure['postgres'],
            'migrate': first_party['scanner-worker'],
            'queue-init': first_party['scanner-worker'],
            'database-dashboards-install': infrastructure['postgres'],
            'database-access-finalize': infrastructure['postgres'],
            'web': first_party['scanner-web'],
            'worker': first_party['scanner-worker'],
            'privacy-cleanup': first_party['scanner-privacy'],
            'database-backup': infrastructure['postgres'],
            'database-config-check': infrastructure['alpine'],
            'database-access-verify': infrastructure['postgres'],
        },
    }


def compare_topologies(test_path, production_path, revision, identity):
    channels = {
        'test': json.loads(Path(test_path).read_text()),
        'production': json.loads(Path(production_path).read_text()),
    }
    for channel_name, topology in channels.items():
        require(topology.get('revision') == revision, channel_name + ' topology names another revision')
    assigned_images = expected_images(identity)
    for surface in ['commerce', 'scanner']:
        test_roles = channels['test'].get(surface, {})
        production_roles = channels['production'].get(surface, {})
        require(set(test_roles) == EXPECTED_ROLES[surface], 'test ' + surface + ' service roles differ from the reviewed topology')
        require(set(production_roles) == EXPECTED_ROLES[surface], 'production ' + surface + ' service roles differ from the reviewed topology')
        for role in sorted(test_roles):
            require(test_roles[role].get('image') == assigned_images[surface][role], 'test ' + surface + '.' + role + ' uses an unassigned image')
            require(production_roles[role].get('image') == assigned_images[surface][role], 'production ' + surface + '.' + role + ' uses an unassigned image')
            for field in ['image', 'command']:
                require(
                    test_roles[role].get(field) == production_roles[role].get(field),
                    surface + '.' + role + ' ' + field + ' differs between channels',
                )
    print('Test and production use the same revision, service roles, image tags and commands')


def validate_test_acceptance(runtime_path, acceptance_path, revision):
    runtime = json.loads(Path(runtime_path).read_text())
    acceptance = json.loads(Path(acceptance_path).read_text())
    require(runtime.get('revision') == revision, 'Test runtime evidence names another revision')
    require(runtime.get('channel') == 'test', 'Runtime evidence is not from the test channel')
    expected_services = {
        'agentify-test-postgres-1', 'agentify-test-gateway-1',
        'agentify-test-cabinet-1', 'agentify-test-web-1',
        'agentify-test-scanner-web-1', 'agentify-test-scanner-worker-1',
    }
    require({entry.get('name') for entry in runtime.get('services', [])} == expected_services, 'Test runtime evidence omits a resident service')
    expected_first_party = {'commerce-app', 'commerce-web', 'scanner-web', 'scanner-worker', 'scanner-privacy'}
    require({entry.get('role') for entry in runtime.get('firstPartyImages', [])} == expected_first_party, 'Test runtime evidence omits a first-party image')
    require(acceptance.get('revision') == revision, 'Test acceptance names another revision')
    require(acceptance.get('accepted') is True, 'Test acceptance is absent')
    print('Accepted test runtime evidence matches the selected revision and expected roles')


mode = sys.argv[1]
if mode == 'compare':
    compare_topologies(sys.argv[2], sys.argv[3], sys.argv[4], json.loads(sys.argv[5]))
    raise SystemExit(0)
if mode == 'acceptance':
    validate_test_acceptance(sys.argv[2], sys.argv[3], sys.argv[4])
    raise SystemExit(0)

directory, channel_name = sys.argv[2:4]
root = Path(directory)
channel = json.loads(sys.argv[4])
revision = sys.argv[5]
identity = json.loads(sys.argv[6])
configs = {surface: json.loads((root / (surface + '-resolved.json')).read_text()) for surface in ['commerce', 'scanner']}


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name]))[0]


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
assigned_images = expected_images(identity)
for surface, config in configs.items():
    roles = config['services']
    require(set(roles) == EXPECTED_ROLES[surface], surface + ' service roles differ from the reviewed topology')
    normalized[surface] = {}
    for role, service in roles.items():
        require('build' not in service, surface + '.' + role + ' still has a build definition')
        require(service.get('image') == assigned_images[surface][role], surface + '.' + role + ' uses an unassigned image')
        # Compose emits command: null when a service inherits the image command.
        # Store null explicitly so absent and null compare as the same behavior.
        normalized[surface][role] = {'image': service['image'], 'command': service.get('command')}
        if surface == 'scanner':
            require(not service.get('ports'), 'Scanner services must not publish host ports')
            environment = service.get('environment', {})
            if role in ['web', 'worker', 'privacy-cleanup']:
                require(environment.get('APP_BASE_URL') == channel['origin'], role + ' uses the wrong scanner origin')
            for key in ['DATABASE_URL', 'ADMIN_DATABASE_URL', 'WEB_DATABASE_URL', 'WORKER_DATABASE_URL', 'PRIVACY_DATABASE_URL', 'DASHBOARD_DATABASE_URL']:
                if environment.get(key):
                    require(environment[key].endswith('@agentify-scanner-postgres:5432/agentify_scanner'), role + ' uses a database outside its private scanner network')
    if surface == 'commerce':
        require(config['volumes']['agentify-postgres']['name'] == channel['postgres_volume'], 'Commerce data volume differs from the retained channel volume')
        require(config['volumes']['agentify-caddy']['name'] == channel['caddy_volume'], 'Commerce certificate volume differs')
    require(config['networks']['agentify-scanner-db']['name'] == channel['database_network'], 'Wrong scanner database network')
    require(config['networks']['agentify-ingress']['name'] == channel['ingress_network'], 'Wrong channel ingress network')

if mode == 'topology':
    topology = {'revision': revision, **normalized, 'scannerPolicy': scanner_policy}
    (root / 'topology.json').write_text(json.dumps(topology, indent=2) + '\n')
    print('Rendered revision, image, command, origin, volume and private-network topology captured')
elif mode == 'verify':
    services = {'commerce': ['postgres', 'gateway', 'cabinet', 'web'], 'scanner': ['web', 'worker']}
    evidence = {'revision': revision, 'channel': channel_name, 'services': []}
    infrastructure = set(identity['infrastructure'].values())
    for surface, roles in services.items():
        for role in roles:
            config = configs[surface]['services'][role]
            name = channel[surface + '_project'] + '-' + role + '-1'
            container = inspect('container', name)
            image = inspect('image', config['image'])
            require(container['State']['Running'], name + ' is not running')
            require(container['State'].get('Health', {}).get('Status', 'healthy') == 'healthy', name + ' is unhealthy')
            require(container['Config']['Image'] == config['image'], name + ' does not name its assigned image tag')
            require(container['Image'] == image['Id'], name + ' does not run the current assigned image ID')
            if config['image'] not in infrastructure:
                labels = image['Config'].get('Labels', {})
                require(labels.get('org.opencontainers.image.revision') == revision, name + ' was built from another revision')
                require(labels.get('org.opencontainers.image.source') == 'https://github.com/nuanu-ai/agentify', name + ' was built from another repository')
            environment = dict(line.split('=', 1) for line in container['Config']['Env'] if '=' in line)
            for key, value in config.get('environment', {}).items():
                require(environment.get(key) == str(value), name + ' environment mismatch: ' + key)
            evidence['services'].append({'name': name, 'image': config['image'], 'imageId': container['Image'], 'containerId': container['Id']})
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
