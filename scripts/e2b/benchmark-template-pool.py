"""Isolated component comparison for #1505 versus #1508; never a production run.

Both arms use one CI host, one E2B key, the same public source/worker digest,
and the official base's CPU/memory allocation. The pool uses the unchanged
claim SQL from PR #1508 d14a5652e6a737944e8e5dbffc256833ca7f7eec against a
dedicated local PostgreSQL service. No application identity or model is used.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import statistics
import sys
import time
from urllib.parse import urlparse
import uuid

HERE = Path(__file__).resolve().parent
POOL_SOURCE = 'd14a5652e6a737944e8e5dbffc256833ca7f7eec'
POOL_BLOB = '617d57e5046ca0acbc83dc1f64ba069a758b24b4'
READY = r'''set -eu
test ! -e /home/user/.mikka/bootstrap.json
test ! -e /home/user/.mikka/worker/device.json
read -r p < /home/user/.mikka/preloaded.pid
kill -0 "$p"
tr '\0' '\n' < "/proc/$p/cmdline" | grep -Fxq -- '--wait-bootstrap'
test "$(cat /opt/mikka/worker-source-sha)" = WORKER_SHA
'''
PRELOAD = ('cd /opt/mikka/worker/packages/daemon && '
           'export PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:$PATH && '
           'export HOME=/home/user && exec node dist/cloud/cloud-worker.js --wait-bootstrap')


def claim_sql(source, values):
    """Keep the upstream SQL exact; adapt only pg's numbered bind syntax."""
    raw = source.encode()
    digest = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if digest != POOL_BLOB:
        raise ValueError('pool_source_fixture_changed')
    sql = re.search(r'`(UPDATE thread_machine_pool SET "claimedBy"=\$4,.*?RETURNING "sandboxId")`', source, re.S)
    if not sql:
        raise ValueError('pool_claim_sql_missing')
    parameters = []
    def parameter(match):
        parameters.append(values[int(match[1]) - 1])
        return '%s'
    return re.sub(r'\$(\d+)', parameter, sql[1]), parameters


def run():
    from concurrent.futures import ThreadPoolExecutor
    from e2b import Sandbox
    import psycopg
    spec = importlib.util.spec_from_file_location('build_template', HERE / 'build-template.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    key = os.environ['E2B_API_KEY']
    dsn = os.environ['BENCHMARK_DATABASE_URL']
    parsed = urlparse(dsn)
    if parsed.hostname != '127.0.0.1' or parsed.path != '/mikka_1505_components':
        raise ValueError('isolated_database_required')
    sha = builder.commit('HEAD')
    worker = builder.worker_hash(sha)
    prefix = 'mikka-1505-component-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
    owner = str(uuid.uuid4())
    source = (HERE / 'benchmark-fixtures/thread-machine-pool.ts').read_text()
    claim_sql(source, [owner, 'claude', worker, str(uuid.uuid4())])
    report = {'version': 1, 'scope': 'component-only; no dispatch or agent execution',
              'sourceCommit': sha, 'workerSha': worker, 'poolSourceCommit': POOL_SOURCE,
              'poolClaimSourceBlob': POOL_BLOB, 'runsPerKindAndStrategy': 3,
              'sameRunnerAndApiKey': True, 'templates': {}, 'samples': [], 'cleanup': []}
    instances = set()
    templates = {}
    output = HERE / 'component-benchmark.json'
    def save():
        output.write_text(json.dumps(report, indent=2) + '\n')
    def measured(name, action, marks):
        began = time.perf_counter()
        result = action()
        marks[name] = round((time.perf_counter() - began) * 1000, 3)
        return result
    def ready(sandbox):
        result = sandbox.commands.run(READY.replace('WORKER_SHA', worker), user='user', timeout=30)
        if result.exit_code != 0:
            raise RuntimeError('anonymous_worker_not_ready')
    def create(template):
        sandbox = Sandbox.create(template, api_key=key, timeout=600,
                                 metadata={'application': 'mikka-1505-component', 'run': os.environ['GITHUB_RUN_ID']})
        instances.add(sandbox.sandbox_id)
        return sandbox
    def kill(sandbox):
        Sandbox.kill(sandbox.sandbox_id, api_key=key)
        instances.discard(sandbox.sandbox_id)
    def resources(sandbox):
        info = sandbox.get_info()
        return {'cpuCount': info.cpu_count, 'memoryMB': info.memory_mb}
    try:
        def build_one(kind):
            # Use the exact official-base allocation for a like-for-like test.
            base = create(kind)
            try:
                allocation = resources(base)
            finally:
                kill(base)
            _, result = builder.build(prefix + '-' + kind, sha, api_key=key, kind=kind,
                                      cpu_count=allocation['cpuCount'], memory_mb=allocation['memoryMB'],
                                      on_build_logs=lambda entry: print(f'[{kind}] {entry}', file=sys.stderr, flush=True))
            templates[kind] = result.template_id
            proof = builder.probe_conservation(result.template_id, key, kind)
            print('mikka-component-conservation ' + json.dumps({'kind': kind, 'conservation': proof}, separators=(',', ':')), flush=True)
            models = builder.probe_models(result.template_id, kind, key)
            return kind, {'templateId': result.template_id, 'buildId': result.build_id,
                          'baseTemplate': kind, 'preinstalled': True, 'resources': allocation,
                          'conservation': proof, 'models': models}
        with ThreadPoolExecutor(max_workers=3) as executor:
            report['templates'] = dict(executor.map(build_one, ['claude', 'codex', 'desktop']))
        save()
        with psycopg.connect(dsn, autocommit=True) as db:
            db.execute('CREATE TABLE "user" (id text PRIMARY KEY)')
            db.execute((HERE / 'benchmark-fixtures/thread-machine-pool.sql').read_text())
            db.execute('INSERT INTO "user" (id) VALUES (%s)', (owner,))
            for kind, candidate in report['templates'].items():
                for index in range(3):
                    # Alternate arms in each pair so runner/network drift is visible.
                    for strategy in ('derived', 'pool') if index % 2 == 0 else ('pool', 'derived'):
                        row = {'kind': kind, 'strategy': strategy, 'sample': index + 1, 'timingsMs': {}}
                        marks = row['timingsMs']
                        sandbox = None
                        try:
                            if strategy == 'derived':
                                began = time.perf_counter()
                                sandbox = measured('create', lambda: create(candidate['templateId']), marks)
                                measured('workerReady', lambda: ready(sandbox), marks)
                                row['requestToReadyMs'] = round((time.perf_counter() - began) * 1000, 3)
                            else:
                                sandbox = measured('prepareCreate', lambda: create(kind), marks)
                                bootstrap = (builder.ROOT / builder.INSTANCE_BOOTSTRAP).read_text()
                                sandbox.files.write('/tmp/mikka-1505-bootstrap.sh', bootstrap, user='root')
                                measured('prepareBootstrap', lambda: sandbox.commands.run(
                                    f'bash /tmp/mikka-1505-bootstrap.sh {sha} {worker} {kind}', user='root', timeout=300), marks)
                                measured('preparePreload', lambda: sandbox.commands.run(
                                    PRELOAD, user='user', background=True, timeout=0), marks)
                                measured('prepareReady', lambda: sandbox.commands.run(
                                    'for i in $(seq 1 300); do test -s /home/user/.mikka/preloaded.pid && exit 0; sleep .05; done; exit 1',
                                    user='user', timeout=30), marks)
                                measured('prepareDropCaches', lambda: sandbox.commands.run(
                                    'sync; echo 3 > /proc/sys/vm/drop_caches', user='root', timeout=30), marks)
                                measured('preparePause', sandbox.pause, marks)
                                db.execute('INSERT INTO thread_machine_pool (id,"ownerId",template,"workerSha",state,"sandboxId","readyAt") VALUES (%s,%s,%s,%s,\'ready\',%s,now())',
                                           (str(uuid.uuid4()), owner, kind, worker, sandbox.sandbox_id))
                                # The upstream comparison leaves the pool idle for 60 seconds.
                                time.sleep(60)
                                operation = str(uuid.uuid4())
                                sql, values = claim_sql(source, [owner, kind, worker, operation])
                                began = time.perf_counter()
                                claimed = measured('claimSql', lambda: db.execute(sql, values).fetchone(), marks)
                                if not claimed or claimed[0] != sandbox.sandbox_id:
                                    raise RuntimeError('pool_claim_wrong_instance')
                                sandbox = measured('resume', lambda: Sandbox.connect(claimed[0], api_key=key, timeout=600), marks)
                                measured('workerReady', lambda: ready(sandbox), marks)
                                row['requestToReadyMs'] = round((time.perf_counter() - began) * 1000, 3)
                                measured('forgetSql', lambda: db.execute('DELETE FROM thread_machine_pool WHERE "sandboxId"=%s AND "claimedBy" IS NOT NULL', (sandbox.sandbox_id,)), marks)
                            allocation = resources(sandbox)
                            if allocation != candidate['resources']:
                                raise RuntimeError('component_resources_mismatch')
                            row['resources'] = allocation
                            row['anonymousWorkerVerified'] = True
                            row['status'] = 'passed'
                            report['samples'].append(row)
                            print('mikka-component-sample ' + json.dumps(row, separators=(',', ':')), flush=True)
                            save()
                        finally:
                            if sandbox is not None:
                                kill(sandbox)
        report['summary'] = {kind: {strategy: {
            'medianMs': statistics.median(row['requestToReadyMs'] for row in report['samples'] if row['kind'] == kind and row['strategy'] == strategy),
            'maxMs': max(row['requestToReadyMs'] for row in report['samples'] if row['kind'] == kind and row['strategy'] == strategy),
        } for strategy in ('derived', 'pool')} for kind in report['templates']}
        report['status'] = 'component_comparison_passed'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = type(error).__name__
        raise
    finally:
        for sandbox_id in tuple(instances):
            try:
                Sandbox.kill(sandbox_id, api_key=key)
                instances.discard(sandbox_id)
            except Exception as error:
                report['cleanup'].append({'resource': 'sandbox', 'id': sandbox_id, 'error': type(error).__name__})
        # The ops source is intentionally never published. Remove only this
        # run's uniquely named candidates; released/previous templates stay intact.
        for kind in ('claude', 'codex', 'desktop'):
            name = prefix + '-' + kind
            try:
                info = builder._request('GET', '/templates/' + name, key)
                names = info.get('names', []) + info.get('aliases', [])
                if name not in names or info.get('isDefault') is True:
                    raise RuntimeError('component_cleanup_name_mismatch')
                builder._request('DELETE', '/templates/' + info['templateID'], key)
            except Exception as error:
                if getattr(error, 'code', None) != 404:
                    report['cleanup'].append({'resource': 'candidate', 'kind': kind, 'error': type(error).__name__})
        report['remainingSandboxes'] = sorted(instances)
        save()
        print('mikka-component-result ' + json.dumps({key: report[key] for key in ('status', 'sourceCommit', 'workerSha', 'remainingSandboxes', 'cleanup')}, separators=(',', ':')), flush=True)
    if report['cleanup'] or report['remainingSandboxes']:
        raise RuntimeError('component_cleanup_incomplete')


if __name__ == '__main__':
    run()
