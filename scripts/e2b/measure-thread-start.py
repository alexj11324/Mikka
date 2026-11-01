"""Times each step of a cloud thread start (lib/cloud-computer/thread-machines.ts ensureThreadMachine,
then the hosted runner's container) on a throwaway sandbox, to find the latency Mikka adds on top of E2B's boot.

  E2B_API_KEY=... python3 scripts/e2b/measure-thread-start.py template:<templateId>
  E2B_API_KEY=... python3 scripts/e2b/measure-thread-start.py snapshot-of:<botSandboxId>

The key is read from the environment and never printed. The sandbox (and a snapshot it made) is deleted at the end.
Use a test account's E2B team only.
"""
import json, os, sys, time, pathlib
key = os.environ['E2B_API_KEY']
from e2b import Sandbox
REPO = pathlib.Path(__file__).resolve().parent
IMG = 'node@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a'
D = 'docker --host=unix:///run/mikka-container/docker.sock'
marks = []
def mark(name, start):
    marks.append((name, round(time.time() - start, 2))); print(f'{name:48s} {marks[-1][1]:7.2f}s', flush=True)
mode = sys.argv[1]  # 'template:<id>' or 'snapshot-of:<sandbox>'
if mode.startswith('snapshot-of:'):
    t = time.time(); src = Sandbox.connect(mode.split(':', 1)[1], api_key=key); mark('connect bot machine (resume)', t)
    t = time.time(); snap = src.create_snapshot(); source = snap.snapshot_id; mark('workspace snapshot (cached 24h in prod)', t)
else:
    source = mode.split(':', 1)[1]
T0 = time.time()
sbx = Sandbox.create(source, api_key=key, timeout=900, metadata={'purpose': 'latency-measure'})
mark('E2B Sandbox.create -> ready  [E2B boot]', T0)
try:
    run = lambda c, u='root', **k: sbx.commands.run(c, user=u, timeout=300, **k)
    t = time.time(); run('rm -rf /home/mikka-runner/.mikka/worker /home/mikka-runner/.mikka/bootstrap.json /run/mikka-viewer /run/mikka-subagents; install -d -m 700 /run/mikka-viewer'); mark('scrub', t)
    t = time.time()
    run("install -d -m 710 -o root -g mikka-runner /run/mikka-viewer; umask 077; head -c 32 /dev/urandom > /run/mikka-viewer/key")
    for n in ('start-desktop.sh', 'viewer-gateway.py', 'lease-driver.py'): sbx.files.write(f'/opt/mikka/computer/{n}', (REPO / n).read_text(), user='root')
    run('chmod 0755 /opt/mikka/computer/lease-driver.py')
    run('flock -n /run/mikka-viewer/gateway.lock /usr/bin/python3 /opt/mikka/computer/viewer-gateway.py', background=True)
    run('for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6080/vnc)" = 401 ] && exit 0; sleep .2; done; exit 1')
    mark('installComputerRuntime (5 RPCs + viewer gateway)', t)
    t = time.time()
    sbx.files.write('/opt/mikka/computer/start-container-runtime.sh', (REPO / 'start-container-runtime.sh').read_text(), user='root')
    run('bash /opt/mikka/computer/start-container-runtime.sh', background=True)
    run(f'for i in $(seq 1 60); do {D} info >/dev/null 2>&1 && exit 0; sleep .5; done; exit 1')
    mark('ensureContainerRuntime (dockerd up)', t)
    t = time.time(); run(f'{D} image inspect {IMG} >/dev/null 2>&1 || {D} pull {IMG} >/dev/null'); mark('hosted image inspect/pull', t)
    t = time.time(); sbx.files.read('/opt/mikka/worker-source-sha', user='root'); mark('read worker sha', t)
    t = time.time(); sbx.files.write('/run/mikka-viewer/h.json', '{}', user='root'); run('install -d -o mikka-runner -g mikka-runner -m 700 /home/mikka-runner/.mikka; rm -f /run/mikka-viewer/h.json'); mark('handoff write+install (2 RPCs)', t)
    t = time.time(); r = run('cd /opt/mikka/worker/packages/daemon && HOME=/tmp/wh timeout 60 ./node_modules/.bin/tsx bin/cloud-worker.ts 2>&1 | tail -1; true', u='mikka-runner'); mark('worker process load (tsx, to bootstrap check)', t)
    print('   worker said:', r.stdout.strip()[-80:])
    t = time.time(); r = run(f'''cd /tmp && rm -rf lw && mkdir lw && cd lw && git init -q p && git -C p -c user.email=a@b -c user.name=a commit -q --allow-empty -m i && mkdir g && git clone -q --no-checkout p g/repo && S=$EPOCHREALTIME && {D} create --pull=never --name lat --label com.mikka.native.resource=x --init --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user $(id -u):$(id -g) --memory=1g --cpus=2 --pids-limit=128 --tmpfs /tmp:rw,nosuid,nodev,size=128m -e HOME=/tmp -v $PWD/p:/project -v $PWD/p/.git:/project/.git:ro -v $PWD/g/repo/.git:/runtime-git -w /project {IMG} /bin/sh -c 'node -e 0' >/dev/null && C=$EPOCHREALTIME && {D} start -a lat && E=$EPOCHREALTIME && python3 -c "print('create',round($C-$S,2),'start',round($E-$C,2))"''', u='mikka-runner'); mark('docker create + start (hosted runner container)', t)
    print('   ', r.stdout.strip()[-60:])
    t = time.time(); r = run('ls -la /usr/local/bin/codex; /usr/local/bin/codex --version 2>&1 | tail -1; ls /opt/mikka/worker/node_modules/.pnpm | grep -m1 claude-agent-sdk-linux', u='mikka-runner'); mark('harness binaries present (codex --version)', t)
    print('   ', r.stdout.strip()[-200:])
finally:
    total = round(time.time() - T0, 2)
    Sandbox.kill(sbx.sandbox_id, api_key=key)
    if mode.startswith('snapshot-of:'):
        try: Sandbox.delete_snapshot(source, api_key=key)
        except Exception as e: print('snapshot delete', e)
    print(json.dumps({'source': mode, 'marks': marks, 'total_after_create_request': total}))
