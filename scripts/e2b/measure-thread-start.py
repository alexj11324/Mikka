"""Diagnose startup on a throwaway sandbox in the test account's E2B team.

  E2B_API_KEY=... python3 scripts/e2b/measure-thread-start.py template:<id>

Uses the current no-Docker hosted path. A preloaded worker is woken with an
invalid synthetic handoff and must refuse it. Older templates are measured to
the missing-bootstrap check. Neither probe registers a device or supplies keys.
It is not the Coordinator-to-first-agent-event acceptance measurement.
Never use production account credentials. The sandbox is killed in finally.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

HERE = Path(__file__).resolve().parent
COMPUTER_FILES = ('viewer-gateway.py', 'lease-driver.py')
DOCKER_FREE_WORKER = ('cd /opt/mikka/worker/packages/daemon && '
                     'if test -f dist/cloud/cloud-worker.js; then node dist/cloud/cloud-worker.js; '
                     'else ./node_modules/.bin/tsx bin/cloud-worker.ts; fi')

def runtime_command():
    manifest = '\n'.join(f'{hashlib.sha256((HERE / name).read_bytes()).hexdigest()}  /opt/mikka/computer/{name}' for name in COMPUTER_FILES)
    return f"""if ! sha256sum --check --status <<'MIKKA_RUNTIME_HASHES'
{manifest}
MIKKA_RUNTIME_HASHES
then printf 'mikka-runtime-install-required'; exit 0; fi
set -e
install -d -m 710 -o root -g user /run/mikka-viewer
umask 077
head -c 32 /dev/urandom > /run/mikka-viewer/key
chmod 0755 /opt/mikka/computer/lease-driver.py
nohup flock -n /run/mikka-viewer/gateway.lock /usr/bin/python3 /opt/mikka/computer/viewer-gateway.py </dev/null >>/run/mikka-viewer/gateway.log 2>&1 &
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:6080/vnc)" = 401 ] && exit 0; sleep .2; done
exit 1"""

def measure(source, key):
    from e2b import Sandbox
    marks = []
    def step(name, action):
        began = time.monotonic()
        result = action()
        seconds = round(time.monotonic() - began, 3)
        marks.append({'step': name, 'seconds': seconds})
        print(f'{name:48s} {seconds:7.3f}s', flush=True)
        return result

    requested = time.monotonic()
    sandbox = step('e2b_boot', lambda: Sandbox.create(source, api_key=key, timeout=300, metadata={'purpose': 'mikka-latency-measure'}))
    ready = time.monotonic()
    try:
        run = lambda cmd, user='root': sandbox.commands.run(cmd, user=user, timeout=60)
        step('scrub_copied_worker_identity', lambda: run('rm -rf /home/user/.mikka/worker /home/user/.mikka/bootstrap.json /run/mikka-viewer /run/mikka-subagents; install -d -m 700 /run/mikka-viewer'))
        def runtime():
            command = runtime_command()
            result = run(command)
            if result.stdout.strip() == 'mikka-runtime-install-required':
                sandbox.files.write_files([{'path': f'/opt/mikka/computer/{name}', 'data': (HERE / name).read_text()} for name in COMPUTER_FILES], user='root')
                if run(command).stdout.strip() == 'mikka-runtime-install-required':
                    raise RuntimeError('Runtime file validation failed')
        step('viewer_runtime_current_template_one_rpc', runtime)
        step('read_worker_sha', lambda: sandbox.files.read('/opt/mikka/worker-source-sha', user='root'))
        preloaded = step('inspect_preloaded_worker', lambda: run('read -r p < /home/user/.mikka/preloaded.pid 2>/dev/null || p=; if test -n "$p" && kill -0 "$p" 2>/dev/null && tr "\\0" "\\n" < "/proc/$p/cmdline" | grep -Fxq -- "--wait-bootstrap"; then printf yes; fi', user='user')).stdout.strip() == 'yes'
        def worker_load():
            # Catch only the known missing-handoff refusal. A missing module or
            # binary is a failed probe, never reported as a fast worker start.
            result = run(f"{DOCKER_FREE_WORKER} >/tmp/mikka-worker-load-probe.log 2>&1; result=$?; test \"$result\" = 1 && grep -qx 'Cloud worker unavailable' /tmp/mikka-worker-load-probe.log", user='user')
            return result
        def preloaded_probe():
            # A disposable sandbox only. The invalid handoff ends its waiting
            # worker without starting a daemon, making the hot activation time
            # visible without any application account or model credential.
            return run("read -r p < /home/user/.mikka/preloaded.pid; umask 077; printf '{}' > /home/user/.mikka/bootstrap.next; mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json; kill -USR1 \"$p\"; for i in $(seq 1 3000); do if test ! -e /home/user/.mikka/preloaded.pid && grep -qx 'Cloud worker unavailable' /home/user/.mikka/worker-preload.log; then exit 0; fi; sleep .01; done; exit 1", user='user')
        step('preloaded_handoff_to_refusal' if preloaded else 'worker_load_to_missing_bootstrap_refusal', preloaded_probe if preloaded else worker_load)
        out = {'source': source, 'marks': marks, 'e2bBootSeconds': round(ready - requested, 3),
               'diagnosticAfterBootSeconds': round(time.monotonic() - ready, 3),
               'agentFirstEventSeconds': None, 'addedLatencySeconds': None,
               'workerPreloaded': preloaded,
               'scope': 'diagnostic only; full run acceptance must supply the first agent event'}
        print(json.dumps(out), flush=True)
        return out
    finally:
        Sandbox.kill(sandbox.sandbox_id, api_key=key)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='template:<id> or a pre-existing clean snapshot:<id>')
    args = parser.parse_args()
    kind, _, source = args.source.partition(':')
    if kind not in ('template', 'snapshot') or not source or not all(c.isalnum() or c in '_-' for c in source):
        parser.error('source must be template:<id> or snapshot:<id>')
    key = os.environ.get('E2B_API_KEY')
    if not key:
        parser.error('E2B_API_KEY is required')
    measure(source, key)

if __name__ == '__main__':
    main()
