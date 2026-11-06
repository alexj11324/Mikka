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
import urllib.request

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
    from concurrent.futures import ThreadPoolExecutor, as_completed
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
    kinds = os.environ.get('MIKKA_COMPONENT_KINDS', 'claude,codex,desktop').split(',')
    if not kinds or len(set(kinds)) != len(kinds) or any(kind not in builder.KINDS for kind in kinds):
        raise ValueError('component_kinds_invalid')
    prefix = 'mikka-1505-component-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT']
    owner = str(uuid.uuid4())
    source = (HERE / 'benchmark-fixtures/thread-machine-pool.ts').read_text()
    baseline = json.loads((HERE / 'benchmark-fixtures/official-base-evidence.json').read_text())
    claim_sql(source, [owner, 'claude', worker, str(uuid.uuid4())])
    report = {'version': 1, 'scope': 'component-only; no dispatch or agent execution',
              'sourceCommit': sha, 'workerSha': worker, 'poolSourceCommit': POOL_SOURCE,
              'poolClaimSourceBlob': POOL_BLOB, 'runsPerKindAndStrategy': 3,
              'cachePolicy': 'Both strategies preserve their natural preloaded state; the benchmark never drops filesystem caches.',
              'poolIdlePolicy': 'No artificial delay; three distinct instances are prepared and paused before timing the pairs. Actual paused age is recorded.',
              'officialControlRun': 42285968840,
              'requestedKinds': kinds,
              'deadlineMinutes': 30,
              'sameRunnerAndApiKey': True, 'templates': {}, 'samples': [], 'buildErrors': [], 'cleanup': []}
    instances = set()
    templates = {}
    output = HERE / 'component-benchmark.json'
    first_derived_reported = False
    def progress(body):
        token = os.environ.get('MIKKA_COMPONENT_PROGRESS_TOKEN')
        if not token:
            return
        request = urllib.request.Request('https://api.github.com/repos/alexj11324/Mikka/issues/1505/comments',
            data=json.dumps({'body': body}).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read()
        except Exception as error:
            # Reporting is outside all measurement windows. The parent can
            # recover the full artifact even if the issue API is unavailable.
            print('mikka-component-progress-unavailable ' + type(error).__name__, flush=True)
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
                                 metadata={**builder.release_metadata(), 'application': 'mikka-1505-component'})
        instances.add(sandbox.sandbox_id)
        return sandbox
    def kill(sandbox):
        Sandbox.kill(sandbox.sandbox_id, api_key=key)
        instances.discard(sandbox.sandbox_id)
    def resources(sandbox):
        info = sandbox.get_info()
        return {'cpuCount': info.cpu_count, 'memoryMB': info.memory_mb}
    def prepare_pool(kind):
        marks = {}
        sandbox = measured('prepareCreate', lambda: create(kind), marks)
        bootstrap = (builder.ROOT / builder.INSTANCE_BOOTSTRAP).read_text()
        sandbox.files.write('/tmp/mikka-1505-bootstrap.sh', bootstrap, user='root')
        measured('prepareBootstrap', lambda: sandbox.commands.run(
            f'bash /tmp/mikka-1505-bootstrap.sh {sha} {worker} {kind}', user='root', timeout=300), marks)
        measured('preparePreload', lambda: sandbox.commands.run(
            PRELOAD, user='user', background=True, timeout=0), marks)
        measured('prepareReady', lambda: sandbox.commands.run(
            'for i in $(seq 1 300); do test -s /home/user/.mikka/preloaded.pid && break; sleep .05; done; '
            + READY.replace('WORKER_SHA', worker), user='user', timeout=30), marks)
        measured('preparePause', sandbox.pause, marks)
        return {'sandbox': sandbox, 'marks': marks, 'pausedAt': time.perf_counter(), 'pausedEpoch': time.time()}
    try:
        def build_one(kind):
            phase = 'base_resources'
            began = time.perf_counter()
            # Use the exact official-base allocation for a like-for-like test.
            base = create(kind)
            try:
                allocation = resources(base)
            finally:
                kill(base)
            phase = 'build'
            expected = baseline['templates'][kind]
            observed = {}
            def build_log(entry):
                message = str(entry)
                match = re.search(r'FROM TEMPLATE ' + kind + r' \[([a-f0-9]{64})\]', message)
                if match:
                    observed['baseCacheKey'] = match[1]
                    # This is an SDK build-cache key, not a content digest.
                    # Resource/disk settings can alter it. Reuse of the old
                    # official control is decided by the full protected-file
                    # fingerprint below, never by ignoring changed software.
                if '"original":' in message:
                    value = json.loads(message[message.index('{'):])
                    if value.get('kind') != kind or value.get('original') != expected['originalCli']:
                        raise RuntimeError('official_cli_changed_control_required')
                    observed['originalCli'] = value['original']
                print(f'[{kind}] {entry}', file=sys.stderr, flush=True)
            _, result = builder.build(prefix + '-' + kind, sha, api_key=key, kind=kind,
                                      cpu_count=allocation['cpuCount'], memory_mb=allocation['memoryMB'],
                                      on_build_logs=build_log)
            templates[kind] = result.template_id
            try:
                if not observed.get('baseCacheKey') or observed.get('originalCli') != expected['originalCli']:
                    raise RuntimeError('official_control_evidence_not_reproduced')
                phase = 'conservation'
                proof = builder.probe_conservation(result.template_id, key, kind)
                observed['protectedFingerprint'] = proof['finalization']['before']
                if observed['protectedFingerprint'] != expected['protectedFingerprint']:
                    raise RuntimeError('official_base_contents_changed_control_required')
                print('mikka-component-control-reuse ' + json.dumps({'kind': kind, **observed}, separators=(',', ':')), flush=True)
                phase = 'models'
                models = builder.probe_models(result.template_id, kind, key)
                if kind == 'claude':
                    phase = 'offline_claude_ack'
                    probe = create(result.template_id)
                    try:
                        probe.files.write('/tmp/mikka-official-ack.mjs', (HERE / 'probe-claude-ack.mjs').read_text(), user='user')
                        ack_result = probe.commands.run('export PATH=/opt/mikka/runtime/node/bin:$PATH; node /tmp/mikka-official-ack.mjs',
                                                       user='user', timeout=30, request_timeout=35)
                        ack = json.loads(ack_result.stdout)
                        if ack.get('exactUserAck') is not True or ack.get('shouldQuery') is not False:
                            raise RuntimeError('official_claude_ack_missing')
                        print('mikka-component-claude-protocol ' + json.dumps({'kind': kind, 'templateId': result.template_id,
                              'sourceCommit': sha, 'workerSha': worker, **ack}, separators=(',', ':')), flush=True)
                    finally:
                        kill(probe)
            except Exception as error:
                detail = {'kind': kind, 'phase': phase, 'error': type(error).__name__, 'elapsedMs': round((time.perf_counter() - began) * 1000)}
                if str(error) in ('official_base_contents_changed_control_required',
                                  'official_control_evidence_not_reproduced', 'official_claude_ack_missing'):
                    detail.update(reason=str(error), observed=observed)
                # Only our checker's metadata/hash diagnostic is allowed here;
                # SDK error representations can contain response credentials.
                for line in getattr(error, 'stderr', '').splitlines():
                    marker = 'RuntimeError: official_files_changed '
                    if line.startswith(marker):
                        detail['officialChanges'] = json.loads(line.removeprefix(marker))
                print('mikka-component-validation-failed ' + json.dumps(detail, separators=(',', ':')), flush=True)
                raise
            print('mikka-component-conservation ' + json.dumps({'kind': kind, 'conservation': proof}, separators=(',', ':')), flush=True)
            return kind, {'templateId': result.template_id, 'buildId': result.build_id,
                          'baseTemplate': kind, 'preinstalled': True, 'resources': allocation,
                          'conservation': proof, 'models': models, 'reusedOfficialControl': observed}
        with ThreadPoolExecutor(max_workers=len(kinds)) as executor:
            pending = {executor.submit(build_one, kind): kind for kind in kinds}
            for future in as_completed(pending):
                kind = pending[future]
                try:
                    _, built = future.result()
                    report['templates'][kind] = built
                except Exception as error:
                    report['buildErrors'].append({'kind': kind, 'error': type(error).__name__})
                    print('mikka-component-build-failed ' + json.dumps({'kind': kind, 'error': type(error).__name__}), flush=True)
                save()
        if not report['templates']:
            raise RuntimeError('no_component_candidates_ready')
        save()
        with psycopg.connect(dsn, autocommit=True) as db:
            db.execute('CREATE TABLE "user" (id text PRIMARY KEY)')
            db.execute((HERE / 'benchmark-fixtures/thread-machine-pool.sql').read_text())
            db.execute('INSERT INTO "user" (id) VALUES (%s)', (owner,))
            for kind, candidate in report['templates'].items():
                # Preparation is outside every measured interval. All three
                # distinct instances are paused before any pair starts, so
                # bootstrap traffic cannot compete with the timed creates.
                with ThreadPoolExecutor(max_workers=3) as executor:
                    prepared = list(executor.map(prepare_pool, [kind] * 3))
                for index in range(3):
                    # Alternate arms in each pair so runner/network drift is visible.
                    for strategy in ('derived', 'pool') if index % 2 == 0 else ('pool', 'derived'):
                        row = {'kind': kind, 'strategy': strategy, 'sample': index + 1, 'timingsMs': {}}
                        marks = row['timingsMs']
                        sandbox = None
                        pending_progress = None
                        try:
                            if strategy == 'derived':
                                began = time.perf_counter()
                                sandbox = measured('create', lambda: create(candidate['templateId']), marks)
                                measured('workerReady', lambda: ready(sandbox), marks)
                                row['requestToReadyMs'] = round((time.perf_counter() - began) * 1000, 3)
                            else:
                                pool = prepared[index]
                                sandbox = pool['sandbox']
                                marks.update(pool['marks'])
                                # The real schema permits one unclaimed slot
                                # per owner/template. Refill that slot only
                                # after the prior claim has been removed.
                                db.execute('INSERT INTO thread_machine_pool (id,"ownerId",template,"workerSha",state,"sandboxId","readyAt") VALUES (%s,%s,%s,%s,\'ready\',%s,to_timestamp(%s))',
                                           (str(uuid.uuid4()), owner, kind, worker, sandbox.sandbox_id, pool['pausedEpoch']))
                                operation = str(uuid.uuid4())
                                sql, values = claim_sql(source, [owner, kind, worker, operation])
                                row['pausedAgeMs'] = round((time.perf_counter() - pool['pausedAt']) * 1000, 3)
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
                            if strategy == 'derived' and not first_derived_reported:
                                first_derived_reported = True
                                pending_progress = ('组件测量首条真实样本（不是生产 E2E 验收）：\n\n'
                                         + f"[运行 {os.environ['GITHUB_RUN_ID']}](https://github.com/alexj11324/Mikka/actions/runs/{os.environ['GITHUB_RUN_ID']})，不可变源 `{sha}`。"
                                         + '\n\n```json\n' + json.dumps(row, ensure_ascii=False, indent=2) + '\n```\n\n'
                                         + '这是 fresh derived create → 匿名 worker ready；三轮完整同条件比较及资源清理仍在继续。两臂都保留自然预加载状态，没有人为清空文件缓存。')
                        finally:
                            if sandbox is not None:
                                kill(sandbox)
                        if pending_progress:
                            progress(pending_progress)
        report['summary'] = {kind: {strategy: {
            'medianMs': statistics.median(row['requestToReadyMs'] for row in report['samples'] if row['kind'] == kind and row['strategy'] == strategy),
            'maxMs': max(row['requestToReadyMs'] for row in report['samples'] if row['kind'] == kind and row['strategy'] == strategy),
        } for strategy in ('derived', 'pool')} for kind in report['templates']}
        report['status'] = 'component_comparison_passed' if not report['buildErrors'] else 'component_comparison_incomplete'
        if report['buildErrors']:
            raise RuntimeError('component_candidate_build_failed')
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
        candidates = [{'name': prefix + '-' + kind, 'kind': kind,
                       **({'templateId': templates[kind]} if kind in templates else {})}
                      for kind in ('claude', 'codex', 'desktop')]
        report['templateCleanup'] = builder.cleanup_templates(candidates, key)
        report['cleanup'] += [row for row in report['templateCleanup'] if row['status'] == 'failed']
        report['remainingSandboxes'] = sorted(instances)
        save()
        print('mikka-component-result ' + json.dumps({key: report[key] for key in ('status', 'sourceCommit', 'workerSha', 'remainingSandboxes', 'cleanup')}, separators=(',', ':')), flush=True)
    if report['cleanup'] or report['remainingSandboxes']:
        raise RuntimeError('component_cleanup_incomplete')


if __name__ == '__main__':
    run()
