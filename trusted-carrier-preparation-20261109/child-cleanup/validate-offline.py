"""Compile inactive blocks and exercise only the new pure source-shape guard."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import textwrap

TASK = Path(__file__).resolve().parent
WORKFLOW = TASK / 'bundle/.github/workflows/issue1505-smoke-github-readonly.yml.in'
text = WORKFLOW.read_text()
original = (TASK / 'provenance/original-cleanup.yml.in').read_text()


def blocks(value):
    return [textwrap.dedent(match.group(1)) for match in re.finditer(
        r"^          python3 - <<'PY'\n(.*?)^          PY$", value, re.M | re.S)]


new_blocks, old_blocks = blocks(text), blocks(original)
assert len(new_blocks) == len(old_blocks) == 7
for index, body in enumerate(new_blocks):
    compile(body, f'inactive-workflow-block-{index + 1}', 'exec')
old_ast = [ast.parse(body) for body in old_blocks]
new_ast = [ast.parse(body) for body in new_blocks]


def functions(trees, sources, name):
    return [ast.get_source_segment(source, node)
            for tree, source in zip(trees, sources) for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == name]


unchanged = ['source_matches', 'download_archive', 'verified_receipt', 'stamp', 'check_window']
for name in unchanged:
    assert functions(old_ast, old_blocks, name) == functions(new_ast, new_blocks, name), name
secrets_start = '      - uses: Infisical/secrets-action@'
secrets_end = '      - name: Recheck the actual window and clean only the saved exact child'
secret_block = lambda value: value[value.index(secrets_start):value.index(secrets_end)]
assert secret_block(text) == secret_block(original)
assert secret_block(text).count(secrets_start) == 5
assert text[text.index(secrets_end):] == original[original.index(secrets_end):]
assert text.count('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main') == 3
assert sum(isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'check_window'
           for tree in new_ast for node in ast.walk(tree)) == 7
assert text.count('cancel-in-progress: false') == 2
assert text.count('queue: max') == 2
assert 'group: production-smoke-owner-acceptance' in text and 'group: web-deploy-production' in text
bindings = json.loads((TASK / 'bindings.unfilled.json').read_text())
assert len(bindings['values']) == 19 and all(value is None for value in bindings['values'].values())
assert set(re.findall(r'__REQUIRED_[A-Z0-9_]+__', text)) == set(bindings['markers'].values())
assert bindings['branch'] == bindings['requiredPrepareBranch'] == 'ops/1505-smoke-github-readonly-20261109'
assert bindings['activationAuthorizedByThisPackage'] is False
assert '    if: false # OFFLINE_UNBOUND_DO_NOT_ACTIVATE\n' in text
assert "assert required_bindings['prepareBranch']=='ops/1505-smoke-github-readonly-20261109'" in text
assert "assert required_bindings['prepareRunAttempt']=='1'" in text
assert 'ops/1505-readonly-r7-20261109' not in text

import yaml
workflow = yaml.safe_load(text)
assert workflow['jobs']['cleanup']['if'] is False
assert workflow['jobs']['cleanup']['timeout-minutes'] == bindings['markers']['jobMinutes']

first = new_ast[0]
expected_node = next(node for node in first.body if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'expected' for target in node.targets))
expected = ast.literal_eval(expected_node.value)
assert len(expected) == 5
helper_rows = []
for path, sha in expected.items():
    actual = (TASK / 'bundle' / path).read_bytes()
    trusted = (TASK.parent / 'readonly-trusted-carrier-preparation-1505' / 'bundle' / path).read_bytes()
    assert actual == trusted and hashlib.sha256(actual).hexdigest() == sha
    helper_rows.append({'path': path, 'bytes': len(actual), 'sha256': sha, 'byteIdenticalToTrustedPrepare': True})

guard_node = next(node for node in first.body if isinstance(node, ast.FunctionDef) and node.name == 'verify_source_shape')
scope = {}
exec(compile(ast.Module(body=[guard_node], type_ignores=[]), 'exact-inactive-source-guard', 'exec'), scope)
guard = scope['verify_source_shape']
APP, CLOSED, TREE, HEAD, APP_TREE = (char * 40 for char in 'abcde')
paths = sorted(set(expected) | {'.github/workflows/issue1505-smoke-github-readonly.yml'})
raw = [':000000 100644 ' + '0' * 40 + ' ' + 'f' * 40 + ' A\t' + path for path in paths]
answers = {
    ('rev-parse', APP + '^{commit}'): APP,
    ('rev-parse', CLOSED + '^{tree}'): TREE,
    ('rev-list', '--parents', '-n', '1', 'HEAD'): ' '.join([HEAD, APP, CLOSED]),
    ('diff', '--name-only', '--no-renames', APP, 'HEAD'): '\n'.join(paths),
    ('diff', '--raw', '--no-renames', '--abbrev=40', APP, 'HEAD'): '\n'.join(raw),
    ('rev-parse', APP + '^{tree}'): APP_TREE,
}
parent_key = ('rev-list', '--parents', '-n', '1', 'HEAD')
raw_key = ('diff', '--raw', '--no-renames', '--abbrev=40', APP, 'HEAD')
names_key = ('diff', '--name-only', '--no-renames', APP, 'HEAD')


def run_case(name, changed, reject):
    replies = {**answers, **changed}
    calls = []

    def fake_git(*args):
        calls.append(list(args))
        if args not in replies:
            raise RuntimeError('unexpected git read in offline fixture')
        return replies[args]

    refused = False
    try:
        value = guard(fake_git, APP, CLOSED, TREE, expected)
        assert value == APP_TREE
    except AssertionError:
        refused = True
    assert refused == reject, name
    return {'name': name, 'expected': 'refused' if reject else 'accepted', 'passed': True, 'fakeGitReads': len(calls)}


cases = [run_case('exact APP plus six additions; closed carrier independent of prepare head', {}, False)]
for name, parents in [
    ('wrong parent order', [CLOSED, APP]),
    ('obsolete sole-parent shape', [CLOSED]),
    ('extra third parent', [APP, CLOSED, '1' * 40]),
    ('old prepare-close instead of actual closed carrier', [APP, '2' * 40]),
]:
    cases.append(run_case(name, {parent_key: ' '.join([HEAD, *parents])}, True))
cases.append(run_case('wrong closed carrier tree', {('rev-parse', CLOSED + '^{tree}'): '3' * 40}, True))
cases.append(run_case('APP is not the pinned exact commit', {('rev-parse', APP + '^{commit}'): '4' * 40}, True))
cases.append(run_case('extra inherited H workflow', {names_key: '\n'.join(paths + ['.github/workflows/old-H.yml'])}, True))
cases.append(run_case('missing operator file', {names_key: '\n'.join(paths[:-1])}, True))
for name, line in [
    ('modified product or preexisting operator path', ':100644 100644 ' + '1' * 40 + ' ' + 'f' * 40 + ' M\t' + paths[0]),
    ('symlink mode', raw[0].replace('100644', '120000')),
    ('executable mode', raw[0].replace('100644', '100755')),
    ('rename status', raw[0].replace(' A\t', ' R100\t')),
    ('nonzero old blob on claimed addition', raw[0].replace('0' * 40, '1' * 40)),
    ('zero new blob', raw[0].replace('f' * 40, '0' * 40)),
    ('malformed new blob', raw[0].replace('f' * 40, 'g' * 40)),
]:
    cases.append(run_case(name, {raw_key: '\n'.join([line, *raw[1:]])}, True))
cases.append(run_case('duplicate raw path', {raw_key: '\n'.join([raw[0], raw[0], *raw[2:]])}, True))
cases.append(run_case('extra raw entry despite correct name list', {raw_key: '\n'.join([*raw, raw[0]])}, True))

result = {
    'status': 'passed_offline_only',
    'workflow': {'bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest()},
    'pythonBlocksCompiledWithoutExecution': 7,
    'yamlSyntaxParsed': True,
    'jobDisabled': True,
    'unfilledPins': 19,
    'fiveSecretBlockByteIdentical': True,
    'unchangedFunctions': unchanged,
    'threeMainReadsAndSevenWindowChecksRetained': True,
    'twoQueuesRetained': True,
    'runtimeCleanupAndReceiptUploadTailByteIdentical': True,
    'helpers': helper_rows,
    'sourceGuardCases': cases,
    'sourceGuardCasesPassed': len(cases),
    'sourceGuardCasesFailed': 0,
    'newHelperSuiteRuns': 0,
    'executedRuntimeOrNetworkStatements': False,
    'realGitInvocations': 0,
    'gitObjectsOrRefsCreated': 0,
    'scope': 'Only the exact extracted source-shape function ran with fixed fake Git replies; no workflow, scope function, provider, DB or cleanup operation ran.',
}
target = TASK / 'validation/static-verification.json'
target.parent.mkdir(exist_ok=True)
with target.open('x') as stream:
    stream.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'status': result['status'], 'pythonBlocks': 7, 'sourceGuardCasesPassed': len(cases),
                  'sourceGuardCasesFailed': 0, 'unfilledPins': 19, 'realGitInvocations': 0, 'productionCalls': 0}))
