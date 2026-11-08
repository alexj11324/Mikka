"""Protect a dev server from E2B envd's automatic public port forwarding.

E2B forwards even 127.0.0.1 listeners onto a VM network interface. Before any
preview grant is issued, root therefore installs and verifies IPv4 AND IPv6
INPUT rules. They survive preview close/expiry and are never removed by this
service. Only the authenticated gateway's local loopback connection passes.
"""
import json
import os
import shutil
import subprocess
import sys


class FirewallError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def protect_port(port, *, run=subprocess.run, which=shutil.which):
    if type(port) is not int or not 1024 <= port <= 65535 or port in (49983, 50005):
        raise FirewallError('invalid_port')
    programs = [which(name) for name in ('iptables', 'ip6tables')]
    if not all(programs):
        raise FirewallError('firewall_unsupported')
    for program in programs:
        rule = ['INPUT', '!', '-i', 'lo', '-p', 'tcp', '--dport', str(port),
                '-m', 'comment', '--comment', 'mikka-preview-private', '-j', 'REJECT', '--reject-with', 'tcp-reset']

        def invoke(arguments):
            try:
                return run([program, '--wait', '5', *arguments], stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=7, check=False).returncode
            except (OSError, subprocess.TimeoutExpired) as cause:
                raise FirewallError('firewall_unavailable') from cause

        status = invoke(['--check', *rule])
        if status == 1:
            if invoke(['--insert', rule[0], '1', *rule[1:]]) != 0:
                raise FirewallError('firewall_unavailable')
        elif status != 0:
            raise FirewallError('firewall_unavailable')
        # A successful insertion command alone is not evidence of protection.
        if invoke(['--check', *rule]) != 0:
            raise FirewallError('firewall_unavailable')
    return {'protected': True, 'ipv4': True, 'ipv6': True, 'port': port}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise FirewallError('infrastructure_only')
        print(json.dumps(protect_port(int(sys.argv[1]))))
    except (FirewallError, ValueError, IndexError) as error:
        print(json.dumps({'protected': False, 'code': error.code if isinstance(error, FirewallError) else 'invalid_port'}))
        sys.exit(1)
