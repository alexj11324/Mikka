#!/usr/bin/env python3
"""Render reviewed fresh-child source for local review only; never activate or execute it."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import textwrap

HERE = Path(__file__).resolve().parent
TEMPLATE_SHA = '6e49a194122e1769cb23e3bed7277677070202f4171a6879abf95cac8afb8be8'
BINDINGS_SHA = 'c8f4cd2c019a0cd475863e26b20a64c88a93a350545ceeef6b214e398673d8f2'
SOURCE_SHA = '374eac288fd1bc71f0c80753679379290e94bec80347f2c9f5ac973df67e8ae1'
PARAMETERS = ('mainCommit', 'mainTree', 'orderedParents', 'entryDeadlineUtc', 'hardEndUtc', 'closedCarrierCommit')
DISABLED = '    if: false # OFFLINE_UNBOUND_DO_NOT_ACTIVATE\n'
MARKERS = r'__REQUIRED_[A-Z0-9_]+__'

def require(ok, why):
    if not ok:
        raise ValueError(why)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def load_sources():
    raw = (HERE / 'bindings.pending.json').read_bytes()
    template = (HERE / 'prepare.template.yml.in').read_bytes()
    source = (HERE / 'source-bindings.json').read_bytes()
    require(sha(raw) == BINDINGS_SHA, 'reviewed_binding_shape_changed')
    require(sha(template) == TEMPLATE_SHA, 'reviewed_template_changed')
    require(sha(source) == SOURCE_SHA, 'reviewed_source_binding_changed')
    base, proof = json.loads(raw), json.loads(source)
    text = template.decode()
    require(all(base[key] is None for key in PARAMETERS), 'pending_parameters_must_remain_null')
    require(set(re.findall(MARKERS, text)) == set(base['markers']), 'marker_set_changed')
    require(all(text.count(key) == count for key, count in base['markers'].items()), 'marker_count_changed')
    require(text.count(DISABLED) == 1, 'reviewed_disabled_job_changed')
    for item in proof['helpers']:
        path = HERE / 'bundle' / item['path']
        require(path.is_file() and not path.is_symlink(), 'helper_path_changed')
        data = path.read_bytes()
        require(len(data) == item['bytes'] and sha(data) == item['sha256'] and blob(data) == item['gitBlobOid'],
                'helper_bytes_changed:' + item['path'])
        require('"' + item['path'] + '":"' + item['sha256'] + '"' in text, 'embedded_helper_hash_changed')
    correction = json.loads((HERE / 'provenance/hash-binding-correction.json').read_bytes())
    require(correction['afterWorkflowSha256'] == TEMPLATE_SHA and correction['bytes'] == len(template), 'hash_correction_basis_changed')
    for name, update in correction['updates'].items():
        item = next(x for x in proof['helpers'] if x['path'].endswith('/' + name))
        require(item['sha256'] == update['actualHash'] and update['previousEmbeddedHash'] not in text, 'old_helper_hash_restored')
    tests = json.loads((HERE / 'provenance/offline-tests-after-binding-correction.json').read_bytes())
    require(tests['tests'] == tests['pass'] == 47 and tests['fail'] == tests['skipped'] == tests['exitCode'] == 0
            and tests['workflowSha256'] == TEMPLATE_SHA, 'historical_helper_test_binding_changed')
    return base, text, proof

def render(base, template, config):
    require(set(config) == set(base), 'binding_shape_changed')
    require({k: v for k, v in config.items() if k not in PARAMETERS} ==
            {k: v for k, v in base.items() if k not in PARAMETERS}, 'non_parameter_binding_changed')
    for key in ('mainCommit', 'mainTree', 'closedCarrierCommit'):
        require(type(config[key]) is str and re.fullmatch(r'[a-f0-9]{40}', config[key]), 'source_pin_missing:' + key)
    parents = [config['mainCommit'], config['closedCarrierCommit']]
    require(parents[0] != parents[1] and config['orderedParents'] == parents, 'ordered_parents_changed')
    times = []
    for key in ('entryDeadlineUtc', 'hardEndUtc'):
        value = config[key]
        require(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value),
                'actual_time_missing:' + key)
        times.append(dt.datetime.fromisoformat(value.replace('Z', '+00:00')))
    require(times[0] + dt.timedelta(minutes=15) <= times[1], 'original_cleanup_budget_not_bound')
    replacements = {
        '__REQUIRED_MAIN_SHA__': config['mainCommit'], '__REQUIRED_MAIN_TREE__': config['mainTree'],
        '__REQUIRED_ORDERED_PARENTS_JSON__': json.dumps(parents, separators=(',', ':')),
        '__REQUIRED_CLOSED_CARRIER_SHA__': config['closedCarrierCommit'],
        '__REQUIRED_ENTRY_DEADLINE_UTC__': config['entryDeadlineUtc'], '__REQUIRED_HARD_END_UTC__': config['hardEndUtc'],
    }
    result = template
    for marker, value in replacements.items():
        result = result.replace(marker, value)
    require(not re.search(MARKERS, result), 'unfilled_marker')
    require(result.count(DISABLED) == 1, 'output_must_stay_disabled')
    return result

def syntax_check(text):
    blocks = [textwrap.dedent(m.group(1)) for m in re.finditer(
        r"^          python3 - <<'PY'\n(.*?)^          PY$", text, re.M | re.S)]
    require(len(blocks) == 3, 'python_block_count_changed')
    for index, block in enumerate(blocks):
        compile(block, 'prepare-review-python-' + str(index + 1), 'exec')
    import yaml
    workflow = yaml.safe_load(text)
    job = workflow['jobs']['prepare']
    require(job['if'] is False and job['timeout-minutes'] == 15, 'disabled_job_or_timeout_changed')
    require(workflow['concurrency'] == {'group': 'production-smoke-owner-acceptance', 'cancel-in-progress': False, 'queue': 'max'}, 'shared_queue_changed')
    require(job['concurrency'] == {'group': 'web-deploy-production', 'cancel-in-progress': False, 'queue': 'max'}, 'web_queue_changed')
    scopes = [(s['with']['secret-path'], s['with']['secret-name']) for s in job['steps'] if s.get('uses', '').startswith('Infisical/secrets-action@')]
    require(scopes == [('/neon', 'DATABASE_URL'), ('/vercel', 'MIKKA_DATABASE_URL'), ('/vercel', 'BETTER_AUTH_SECRET'),
                       ('/vercel', 'GITHUB_CLIENT_ID'), ('/vercel', 'GITHUB_CLIENT_SECRET')], 'original_five_scopes_changed')
    require(sum(block.count('def check_window():') for block in blocks) == 3, 'clock_guard_blocks_changed')
    require(sum(len(re.findall(r'^\s*check_window\(\)$', block, re.M)) for block in blocks) == 6, 'clock_guard_calls_changed')
    require(text.count('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main') == 3, 'main_reads_changed')
    return {'pythonBlocksCompiledWithoutExecution': 3, 'yamlParsed': True, 'jobDisabled': True,
            'clockGuardBlocks': 3, 'clockGuardCalls': 6, 'currentMainReads': 3, 'originalOidcScopes': 5,
            'bothQueuesUnchanged': True}

def verify_historical(base, template, proof):
    raw = (HERE / 'historical/binding.json').read_bytes()
    require(sha(raw) == proof['historicalReference']['bindingsSha256'], 'historical_bindings_changed')
    old = json.loads(raw)
    config = dict(base, mainCommit=old['main'], mainTree=old['mainTree'],
                  orderedParents=[old['main'], old['closedCarrier']], closedCarrierCommit=old['closedCarrier'],
                  entryDeadlineUtc=old['entry'], hardEndUtc=old['hard'])
    reviewed = render(base, template, config)
    original_header = '# OFFLINE UNBOUND TEMPLATE. Stored as .yml.in; no ref, activation or production authority.\n'
    historical_header = '# Bound #1505 child preparation; actual window ' + old['start'] + ' to ' + old['hard'] + '.\n'
    require(reviewed.startswith(original_header), 'historical_header_basis_changed')
    reviewed = historical_header + reviewed[len(original_header):]
    active = reviewed.replace(DISABLED, '    if: ' + base['reviewedJobIfAfterBinding'] + '\n')
    closed = reviewed.replace(DISABLED, '    if: false # CLOSED_AFTER_ONE_BOUNDED_PREPARATION\n')
    for name, text in [('active', active), ('closed', closed)]:
        actual = (HERE / 'historical' / (name + '.yml')).read_bytes()
        require(text.encode() == actual and sha(actual) == proof['historicalReference'][name]['sha256'],
                'historical_pure_marker_reconstruction_failed:' + name)
    return {'historicalActiveAndClosedReconstructedByteForByte': True,
            'historicalReconstructionIncludesDeclaredCommentHeaderAndJobIf': True,
            'historicalHeaderOnlyDescribesPastWindow': True,
            'historicalPrepareRun': 42689909155, 'historicalPrepareHead': '683b5010bec31bb8515fba73dfaa0f68bc1898df'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--bindings', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    base, template, proof = load_sources()
    if args.verify:
        require(args.bindings is None and args.out is None, 'verify_takes_no_output')
        checks = syntax_check(template)
        checks.update(verify_historical(base, template, proof))
        try:
            render(base, template, base)
        except ValueError as error:
            require(str(error) == 'source_pin_missing:mainCommit', 'unexpected_pending_rejection')
        else:
            raise ValueError('unfilled_pending_input_accepted')
        print(json.dumps({'status': 'offline_package_verified_disabled', 'distinctUnfilledMarkers': 6,
                          'helpersVerified': 5, 'helperTestsRerun': 0, 'pendingInputRejectedBeforeOutput': True,
                          **checks, 'productionCalls': 0, 'gitObjectsCreated': 0, 'refUpdates': 0}))
        return
    require(args.bindings is not None and args.out is not None, 'bindings_and_out_required')
    require(args.out.resolve().parent == HERE and args.out.name.endswith('.yml.review'), 'output_must_be_local_review_file')
    config = json.loads(args.bindings.read_bytes())
    result = render(base, template, config)
    checks = syntax_check(result)
    data = result.encode()
    report_path = args.out.with_name(args.out.name + '.json')
    require(not args.out.exists() and not report_path.exists(), 'review_output_already_exists')
    with args.out.open('xb') as stream:
        stream.write(data)
    report = {'status': 'fully_bound_review_only_job_disabled', 'workflow': str(args.out),
              'bytes': len(data), 'sha256': sha(data), 'gitBlobOid': blob(data), 'templateSha256': TEMPLATE_SHA,
              'bindingSha256': sha(args.bindings.read_bytes()), 'markerReplacementsOnly': True,
              'sourcePlan': {'appCommit': config['mainCommit'], 'baseTree': config['mainTree'],
                             'orderedParents': config['orderedParents'], 'expectedClosedCarrier': config['closedCarrierCommit'],
                             'exactSixAdditions': ['.github/workflows/issue1505-smoke-github-readonly.yml'] + [x['path'] for x in proof['helpers']],
                             'allAdditionModes': '100644', 'freshRemoteSourceVerificationStillRequired': True},
              **checks, 'runtimeReleaseVerifiedByRenderer': False, 'activationPerformed': False,
              'networkCalls': 0, 'gitObjectsCreated': 0, 'refUpdates': 0}
    with report_path.open('x') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
