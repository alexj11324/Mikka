"""Read the VM's actual pre-worker ingress proof before exposing a preview.

E2B forwards loopback listeners publicly too. Protecting a discovered port at
first preview open is too late: a dev process may already have been exposed.
Only the startup guard installs rules. This module never creates or repairs
them and cannot upgrade an older VM into a supported preview runtime.
"""
import json
import os
import re
import subprocess
import sys

GUARD = '/opt/mikka/runtime/ingress-v1/guard.py'


class FirewallError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def protect_port(port, *, run=subprocess.run):
    if type(port) is not int or not 1024 <= port <= 65535 or port in (49983, 50005):
        raise FirewallError('invalid_port')
    try:
        result = run([sys.executable, GUARD, 'verify'], stdin=subprocess.DEVNULL,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired) as cause:
        raise FirewallError('firewall_unavailable') from cause
    if result.returncode != 0 or len(result.stdout) > 4096:
        raise FirewallError('firewall_unsupported')
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as cause:
        raise FirewallError('firewall_unsupported') from cause
    if not (isinstance(value, dict) and value.get('ok') is True and value.get('version') == 1
            and value.get('preparedBeforeWorker') is True
            and value.get('rulesVerified') == {'ipv4': True, 'ipv6': True}
            and isinstance(value.get('sourceSha256'), str) and re.fullmatch('[a-f0-9]{64}', value['sourceSha256'])
            and isinstance(value.get('bootId'), str) and re.fullmatch('[a-f0-9-]{36}', value['bootId'])
            and type(value.get('installedTicks')) is int and value['installedTicks'] >= 0
            and value.get('providerPorts') in ([49983], [49983, 50005])):
        raise FirewallError('firewall_unsupported')
    return {'protected': True, 'ipv4': True, 'ipv6': True, 'port': port}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise FirewallError('infrastructure_only')
        print(json.dumps(protect_port(int(sys.argv[1]))))
    except (FirewallError, ValueError, IndexError) as error:
        print(json.dumps({'protected': False, 'code': error.code if isinstance(error, FirewallError) else 'invalid_port'}))
        sys.exit(1)
