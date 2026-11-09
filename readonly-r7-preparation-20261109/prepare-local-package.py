from pathlib import Path
import datetime
import difflib
import hashlib
import json
import os
import re
import subprocess
import textwrap
import time

ROOT = Path(__file__).resolve().parent
SOURCE_COMMIT = 'c9b6f9531aa40dde6142291e2ce6bac476c5cea5'
CLOSED = 'e93477fe401c70dca532784e71b76d56877b6899'
OLD_BRANCH = 'ops/1505-smoke-github-readonly-20261109'
NEW_BRANCH = 'ops/1505-readonly-r7-20261109'
OLD_GO = 'root-reviewed-1505-github-http-v6'
NEW_GO = 'root-reviewed-1505-github-r7-20261109-v1'
OLD_MAIN = '111a8dfb8b227ac0441324339ff42e4328ea609a'
OLD_TREE = '6a06f3742fb0dfc35bed19780fe09da2747c1ddc'
OLD_SECOND_PARENT = '01ef3fa435380f23fbd3cd7cfbe77839cc5511d9'
WORKFLOW = '.github/workflows/issue1505-smoke-github-readonly.yml'
PREFIX = 'scripts/ops/issue1505/'
EXPECTED = {
    PREFIX + 'github-readonly-provider.mjs': '23a6f1098e66cddac71e76d6f9c9f41d5da0c3ba8bdf24c964cf4e7cece5851e',
    PREFIX + 'github-readonly-helper.mjs': 'cdafa2f571ed898de2fc9d0a6f208cd3a0e53cfdc1d0777333cf755e73edb742',
    PREFIX + 'github-readonly-store.mjs': '1431219596ce2241f65f01df6642f0145c7f4c3b00f31181fefbc332ad9511d5',
    PREFIX + 'github-readonly-runner.mjs': 'a94187ed60da64a0ef958de1186b2f51dae8f48f154de1895873e5ac351367fb',
    PREFIX + 'github-readonly.test.mjs': '293616146941d59d2196d7343899e1e9e24136ccab03e2025b59dd900e048994',
}

def digest(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}

def put(path, text):
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode('utf-8'))

def json_file(path, value):
    put(path, json.dumps(value, indent=2, ensure_ascii=False) + '\n')

original = json.loads((ROOT / 'provenance/c9-source-input.json').read_bytes())
assert original['sourceCommit'] == SOURCE_COMMIT and original['closedHistoryCommit'] == CLOSED
assert set(original['files']) == set(EXPECTED) | {WORKFLOW}
source_manifest = []
changed = []
prepared = {}
patches = []
for path, wanted in EXPECTED.items():
    before = original['files'][path]
    assert digest(before.encode())['sha256'] == wanted, path
    after = before
    literal_change = path.endswith(('github-readonly-runner.mjs', 'github-readonly.test.mjs'))
    if literal_change:
        assert before.count(OLD_BRANCH) == before.count(OLD_GO) == 1, path
        after = before.replace(OLD_BRANCH, NEW_BRANCH).replace(OLD_GO, NEW_GO)
        assert after.replace(NEW_BRANCH, OLD_BRANCH).replace(NEW_GO, OLD_GO) == before
        changed.append(path)
    else:
        assert after == before
    prepared[path] = after
    put('bundle/' + path, after)
    source_manifest.append({'path': path, 'sourceCommit': SOURCE_COMMIT,
        'sourceUrl': 'https://github.com/alexj11324/Mikka/blob/' + SOURCE_COMMIT + '/' + path,
        'original': digest(before.encode()), 'prepared': digest(after.encode()),
        'change': 'exactly one branch literal and one GO literal' if literal_change else 'byte-identical',
        'inverseBytesMatched': True})
    patches.extend(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile='c9/' + path, tofile='bundle/' + path))
assert changed == [PREFIX + 'github-readonly-runner.mjs', PREFIX + 'github-readonly.test.mjs']
put('provenance/helper-literal-rebinding.patch', ''.join(patches))

before_workflow = original['files'][WORKFLOW]
workflow = before_workflow.replace(OLD_BRANCH, NEW_BRANCH).replace(OLD_GO, NEW_GO)
original_condition = "    if: github.repository == 'alexj11324/Mikka' && github.ref == 'refs/heads/" + NEW_BRANCH + "' && github.run_attempt == 1"
disabled_condition = '    if: false # OFFLINE_UNBOUND_DO_NOT_ACTIVATE'
assert workflow.count(original_condition) == 1
workflow = workflow.replace(original_condition, disabled_condition)
workflow = '# OFFLINE UNBOUND TEMPLATE. Stored as .yml.in; no ref, activation or production authority.\n' + workflow

indent = ' ' * 10
old_parent_check = indent + "assert git('rev-list','--parents','-n','1','HEAD').split()[1:]==['" + OLD_MAIN + "','" + OLD_SECOND_PARENT + "']"
# Keep exact ordered parents and require the closed history as the second parent.
new_parent_check = "\n".join([
    indent + "expected_parents=json.loads('__REQUIRED_ORDERED_PARENTS_JSON__')",
    indent + "assert expected_parents==['__REQUIRED_MAIN_SHA__','" + CLOSED + "'],'ordered_parents_not_bound'",
    indent + "assert git('rev-list','--parents','-n','1','HEAD').split()[1:]==expected_parents",
])
assert workflow.count(old_parent_check) == 1
workflow = workflow.replace(old_parent_check, new_parent_check)
workflow = workflow.replace(OLD_MAIN, '__REQUIRED_MAIN_SHA__').replace(OLD_TREE, '__REQUIRED_MAIN_TREE__')

old_time_check = indent + "assert datetime.datetime.now(datetime.timezone.utc)<datetime.datetime.fromisoformat('2026-11-09T13:40:00+00:00')"
assert workflow.count(old_time_check) == 6
workflow = workflow.replace(old_time_check, indent + 'check_window()')
window_function = "\n".join([
    indent + 'def check_window():',
    indent + "    entry=datetime.datetime.fromisoformat('__REQUIRED_ENTRY_DEADLINE_UTC__')",
    indent + "    hard=datetime.datetime.fromisoformat('__REQUIRED_HARD_END_UTC__')",
    indent + "    assert entry.utcoffset()==datetime.timedelta(0) and hard.utcoffset()==datetime.timedelta(0),'window_must_be_utc'",
    indent + "    assert entry+datetime.timedelta(minutes=15)<=hard,'cleanup_budget_unbound'",
    indent + "    assert datetime.datetime.now(datetime.timezone.utc)<entry,'prepare_entry_closed'",
])
first_import = indent + 'import datetime,hashlib,json,os,pathlib,subprocess'
other_import = indent + 'import datetime\n'
assert workflow.count(first_import) == 1 and workflow.count(other_import) == 2
workflow = workflow.replace(first_import, first_import + '\n' + window_function)
workflow = workflow.replace(other_import, other_import + window_function + '\n')
for path, wanted in EXPECTED.items():
    actual = digest(prepared[path].encode())['sha256']
    assert workflow.count(wanted) == 1
    workflow = workflow.replace(wanted, actual)
template = 'bundle/' + WORKFLOW + '.in'
put(template, workflow)
put('provenance/workflow-preparation.patch', ''.join(difflib.unified_diff(
    before_workflow.splitlines(keepends=True), workflow.splitlines(keepends=True),
    fromfile='c9/' + WORKFLOW, tofile=template)))

# Static verification only: compile inline Python without executing any guard,
# GitHub request, install, OIDC action or production runner.
blocks = re.findall(r"(?ms)^          python3 - <<'PY'\n(.*?)^          PY$", workflow)
assert len(blocks) == 3
for index, block in enumerate(blocks, 1):
    compile(textwrap.dedent(block), '<unbound-workflow-python-' + str(index) + '>', 'exec')
markers = sorted(set(re.findall(r'__REQUIRED_[A-Z_]+__', workflow)))
assert markers == ['__REQUIRED_ENTRY_DEADLINE_UTC__', '__REQUIRED_HARD_END_UTC__', '__REQUIRED_MAIN_SHA__',
                   '__REQUIRED_MAIN_TREE__', '__REQUIRED_ORDERED_PARENTS_JSON__']
assert disabled_condition in workflow and original_condition not in workflow
assert workflow.count('group: production-smoke-owner-acceptance') == 1
assert workflow.count('group: web-deploy-production') == 1
assert workflow.count('timeout-minutes: 15') == 1
assert workflow.count('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main') == 3
assert workflow.count(indent + 'check_window()') == 6
assert workflow.count('def check_window():') == 3
assert workflow.count('uses: Infisical/secrets-action@') == 5
old_secrets = before_workflow[before_workflow.index('      - uses: Infisical/'):before_workflow.index('      - name: Recheck current source')]
new_secrets = workflow[workflow.index('      - uses: Infisical/'):workflow.index('      - name: Recheck current source')]
assert old_secrets == new_secrets
assert OLD_BRANCH not in workflow and OLD_GO not in workflow and OLD_MAIN not in workflow
assert not list((ROOT / 'bundle/.github/workflows').glob('*.yml'))

json_file('bindings.unfilled.json', {
    'version': 1, 'status': 'offline_unbound_disabled', 'branch': NEW_BRANCH, 'go': NEW_GO,
    'mainCommit': None, 'mainTree': None, 'orderedParents': None, 'entryDeadlineUtc': None, 'hardEndUtc': None,
    'requiredFirstParent': 'actual current main selected at the real authorized handoff',
    'requiredSecondParent': CLOSED, 'jobMinutes': 15,
    'workflowJobIf': False, 'reviewedJobIfAfterBinding': original_condition.strip()[4:],
    'markers': {marker: workflow.count(marker) for marker in markers},
    'activationAuthorizedByThisPackage': False, 'sharedCarrierPreparedBy1810MustSuppressDuplicatePreparation': True,
    'createsHold': False, 'addsProductionGate': False,
})
json_file('provenance/source-bindings.json', {'sourceCommit': SOURCE_COMMIT, 'closedHistory': CLOSED,
    'files': source_manifest, 'originalWorkflow': digest(before_workflow.encode()),
    'preparedWorkflow': {'path': template, **digest(workflow.encode())},
    'workflowChanges': ['new exact branch/GO', 'disabled job and non-workflow extension',
                        'unfilled actual main/tree/exact ordered parents',
                        'closed e934 history required as second parent',
                        'unfilled UTC entry/hard-end with unchanged 15-minute job budget',
                        'runner/test digest updates after literal-only changes'],
    'runtimeImplementationChanged': False,
})
json_file('provenance/static-verification.json', {'pythonBlocksCompiledWithoutExecution': len(blocks),
    'threeCurrentMainReadsRetained': True, 'sixBeforeAfterWindowChecksRetained': True,
    'jobMinutes': 15, 'hardEndRule': 'entryDeadlineUtc + 15 minutes <= hardEndUtc',
    'twoExistingQueuesRetained': True, 'fiveOriginalSecretActionsByteIdentical': True,
    'sixPathAllowlistAndAddsOnlyCheckRetained': True, 'exactOrderedParentCheckRetained': True,
    'productDeltaFromActualMainMustRemainZeroOutsideSixOperatorPaths': True,
    'providerHelperStoreByteIdentical': True, 'runnerTestEachOnlyOneBranchAndOneGoLiteral': True,
    'newRegressionTestsAdded': 0, 'allBindingsRemainUnfilled': True,
    'githubWorkflowFilesPresent': 0, 'jobDisabled': True,
    'networkStatementsExecutedForStaticVerification': False})

# The only test invocation is the existing isolated Node fixture suite.
# Drop the process environment except ordinary execution/locale variables.
env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TZ'] if key in os.environ}
args = ['node', '--test', PREFIX + 'github-readonly.test.mjs']
node = subprocess.check_output(['node', '--version'], env=env, text=True).strip()
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
clock = time.monotonic()
result = subprocess.run(args, cwd=ROOT / 'bundle', env=env, capture_output=True, timeout=60)
duration = time.monotonic() - clock
write_path = ROOT / 'tests'
write_path.mkdir(exist_ok=True)
(write_path / 'existing-suite.stdout.txt').write_bytes(result.stdout)
(write_path / 'existing-suite.stderr.txt').write_bytes(result.stderr)
put('tests/existing-suite.exit.txt', str(result.returncode) + '\n')
json_file('tests/existing-suite.result.json', {'args': args, 'cwd': str(ROOT / 'bundle'), 'node': node,
    'startedAt': start, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'durationSeconds': duration, 'exitCode': result.returncode,
    'environmentKeptNamesOnly': sorted(env), 'productionCredentialsPassed': False,
    'sourceFiles': {path: digest(text.encode()) for path, text in prepared.items()},
    'testScope': 'existing mocked provider/store/runner fixture suite, only branch/GO literals changed',
    'productionOrModelCallsClaimed': False})
print(json.dumps({'directory': str(ROOT), 'testExitCode': result.returncode, 'node': node,
    'durationSeconds': duration, 'pythonBlocksCompiled': len(blocks), 'disabled': True,
    'sourceFiles': {path: digest(text.encode()) for path, text in prepared.items()},
    'workflow': digest(workflow.encode())}))
if result.returncode:
    raise SystemExit(result.returncode)
