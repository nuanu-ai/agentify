#!/usr/bin/env python3
"""Start the candidate without a network or published port before stopping live web."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(sys.argv[1])
config = json.loads((root / 'scanner-resolved.json').read_text())['services']['web']
revision = sys.argv[2]
name = 'agentify-configuration-check-' + revision[:12]
file = root / '.web-configuration-check.env'
fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
created = False
try:
    with os.fdopen(fd, 'w') as out:
        for key, value in config['environment'].items():
            value = str(value)
            assert '\n' not in value and '\r' not in value
            out.write(key + '=' + value + '\n')
    subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--env-file', str(file), '--memory', '512m', '--pids-limit', '128', config['image']], check=True, stdout=subprocess.DEVNULL)
    created = True
    for _ in range(45):
        state = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]['State']
        if not state['Running']:
            raise RuntimeError('Candidate web refused its runtime configuration before activation')
        probe = subprocess.run(['docker', 'exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:3000/api/health/live'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Candidate web configuration never became healthy; live services were not touched')
    for path in ['/', '/sitemap.xml', '/robots.txt', '/llms.txt']:
        subprocess.run(['docker', 'exec', name, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:3000'+path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('Candidate public configuration and pages accepted in an isolated container')
finally:
    if created:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, check=True)
    file.unlink(missing_ok=True)
