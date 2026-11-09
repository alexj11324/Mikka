from pathlib import Path
import ast
import difflib
import hashlib
import json
import re
import textwrap

root = Path(__file__).resolve().parent
out = root / 'cleanup'
source_path = out / 'provenance/e5a-workflow.original.yml.txt'
original = source_path.read_bytes()
assert len(original) == 26324
assert hashlib.sha256(original).hexdigest() == 'b73f74994833db10cac6e31e7ab109462e261398a77565d0389d32e4db6a5e9d'
source = original.decode()
prepared = source
replacements = []

def replace(old, new, expected=None):
    global prepared
    count = prepared.count(old)
    assert count and (expected is None or count == expected), (old, count, expected)
    prepared = prepared.replace(old, new)
    replacements.append({'old': old, 'new': new, 'occurrences': count})

branch = 'ops/1505-readonly-r7-20261109'
go = 'root-reviewed-1505-github-r7-20261109-v1'
replace('ops/1505-smoke-github-readonly-20261109', branch)
replace('root-reviewed-1505-github-http-v6', go)
enabled_if = "github.repository == 'alexj11324/Mikka' && github.ref == 'refs/heads/" + branch + "' && github.run_attempt == 1"
replace('    if: ' + enabled_if, '    if: false # OFFLINE_UNBOUND_DO_NOT_ACTIVATE', 1)
replace('# Exact cleanup of the single successful c9 prepare receipt; one bounded entry.', '# OFFLINE UNBOUND TEMPLATE. Cleanup of the next cycle\'s exact new receipt only.', 1)
replace('    timeout-minutes: 10', '    timeout-minutes: __REQUIRED_CLEANUP_JOB_MINUTES__', 1)
replace("MIKKA_1505_CLEANUP_JOB_MINUTES: '10'", "MIKKA_1505_CLEANUP_JOB_MINUTES: '__REQUIRED_CLEANUP_JOB_MINUTES__'", 1)
replace('2026-11-09T13:33:00.000Z', '__REQUIRED_CLEANUP_WINDOW_START_UTC__', 1)
replace('2026-11-09T13:49:00.000Z', '__REQUIRED_CLEANUP_ENTRY_DEADLINE_UTC__', 1)
replace('2026-11-09T13:59:00.000Z', '__REQUIRED_CLEANUP_HARD_END_UTC__', 1)
replace('465f1b89c52228b99c4f2424f92722901b910754', '__REQUIRED_CLEANUP_CLOSED_COMMIT__', 1)
replace('5053519fabc1e8ce3737f0166e61db1b29597be8', '__REQUIRED_CLEANUP_CLOSED_TREE__', 1)
replace('111a8dfb8b227ac0441324339ff42e4328ea609a', '__REQUIRED_CLEANUP_CURRENT_MAIN_SHA__', 4)
replace("run.get('head_branch')=='" + branch + "'", "run.get('head_branch')=='__REQUIRED_PREPARE_BRANCH__'", 2)
replace('c9b6f9531aa40dde6142291e2ce6bac476c5cea5', '__REQUIRED_PREPARE_HEAD_SHA__', 2)
replace('411645081', "int('__REQUIRED_PREPARE_WORKFLOW_ID__')", 1)
replace('issue1505-github-readonly-fresh-42622019169-1', '__REQUIRED_ARTIFACT_NAME__', 1)
replace("'actions/runs/42622019169/attempts/1'", "'actions/runs/__REQUIRED_PREPARE_RUN_ID__/attempts/__REQUIRED_PREPARE_RUN_ATTEMPT__'", 1)
replace("'actions/runs/42622019169'", "'actions/runs/__REQUIRED_PREPARE_RUN_ID__'", 1)
replace('42622019169', "int('__REQUIRED_PREPARE_RUN_ID__')", 3)
replace("run.get('run_attempt')==1", "run.get('run_attempt')==int('__REQUIRED_PREPARE_RUN_ATTEMPT__')", 1)
replace("'sourceAttempt':1", "'sourceAttempt':int('__REQUIRED_PREPARE_RUN_ATTEMPT__')", 1)
replace('actions/artifacts/13677458654', 'actions/artifacts/__REQUIRED_ARTIFACT_ID__', 1)
replace('13677458654', "int('__REQUIRED_ARTIFACT_ID__')", 5)
replace('sha256:87124f31fd4cfc332411985814650992fcdad9f21ca6f5a0709f70abb5c41a81', '__REQUIRED_ARTIFACT_DIGEST__', 1)
replace('87124f31fd4cfc332411985814650992fcdad9f21ca6f5a0709f70abb5c41a81', '__REQUIRED_ZIP_SHA256__', 2)
replace('925', "int('__REQUIRED_ARTIFACT_BYTES__')", 4)
replace('2132', "int('__REQUIRED_RECEIPT_BYTES__')", 1)
replace('80031945234e34264c558f830bd64bfa651858e69dbfdfa6354b62deb2a2022d', '__REQUIRED_RECEIPT_SHA256__', 3)

source_bindings = json.loads((root / 'provenance/source-bindings.json').read_text())
for file in source_bindings['files']:
    old, new = file['original']['sha256'], file['prepared']['sha256']
    assert prepared.count(old) == 1, file['path']
    if old != new:
        replace(old, new, 1)

fields = {
    'prepareRunId': '__REQUIRED_PREPARE_RUN_ID__',
    'prepareRunAttempt': '__REQUIRED_PREPARE_RUN_ATTEMPT__',
    'prepareWorkflowId': '__REQUIRED_PREPARE_WORKFLOW_ID__',
    'prepareHeadSha': '__REQUIRED_PREPARE_HEAD_SHA__',
    'prepareBranch': '__REQUIRED_PREPARE_BRANCH__',
    'artifactId': '__REQUIRED_ARTIFACT_ID__',
    'artifactName': '__REQUIRED_ARTIFACT_NAME__',
    'artifactBytes': '__REQUIRED_ARTIFACT_BYTES__',
    'artifactDigest': '__REQUIRED_ARTIFACT_DIGEST__',
    'zipSha256': '__REQUIRED_ZIP_SHA256__',
    'receiptBytes': '__REQUIRED_RECEIPT_BYTES__',
    'receiptSha256': '__REQUIRED_RECEIPT_SHA256__',
    'cleanupClosedCommit': '__REQUIRED_CLEANUP_CLOSED_COMMIT__',
    'cleanupClosedTree': '__REQUIRED_CLEANUP_CLOSED_TREE__',
    'currentMainSha': '__REQUIRED_CLEANUP_CURRENT_MAIN_SHA__',
    'windowStartUtc': '__REQUIRED_CLEANUP_WINDOW_START_UTC__',
    'entryDeadlineUtc': '__REQUIRED_CLEANUP_ENTRY_DEADLINE_UTC__',
    'hardEndUtc': '__REQUIRED_CLEANUP_HARD_END_UTC__',
    'jobMinutes': '__REQUIRED_CLEANUP_JOB_MINUTES__',
}
guard = '          required_bindings=' + json.dumps(fields, separators=(',', ':')) + '\n'
guard += "          if any(not value or '__REQUIRED_' in value for value in required_bindings.values()):\n"
guard += "            raise SystemExit('issue1505_cleanup_binding_unfilled')\n"
prepared = prepared.replace('          import datetime,os\n', '          import datetime,os\n' + guard, 1)

assert '    if: false # OFFLINE_UNBOUND_DO_NOT_ACTIVATE' in prepared
assert set(re.findall(r'__REQUIRED_[A-Z0-9_]+__', prepared)) == set(fields.values())
assert all(prepared.count(marker) >= 2 for marker in fields.values())
for forbidden in ('42622019169', '13677458654', '465f1b89c52228b99c4f2424f92722901b910754',
                  '111a8dfb8b227ac0441324339ff42e4328ea609a', 'c9b6f9531aa40dde6142291e2ce6bac476c5cea5',
                  '2026-11-09T13:', '87124f31fd4cfc332411985814650992fcdad9f21ca6f5a0709f70abb5c41a81',
                  '80031945234e34264c558f830bd64bfa651858e69dbfdfa6354b62deb2a2022d'):
    assert forbidden not in prepared, forbidden
assert prepared.count('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main') == 3
assert prepared.count('          check_window()') == source.count('          check_window()') == 7
assert prepared.count('group: production-smoke-owner-acceptance') == 1
assert prepared.count('group: web-deploy-production') == 1
assert prepared.count('cancel-in-progress: false') == prepared.count('queue: max') == 2
secret_start = '      - uses: Infisical/secrets-action@'
secret_end = '      - name: Recheck the actual window and clean only the saved exact child'
def secrets(text):
    return text[text.index(secret_start):text.index(secret_end)]
assert secrets(prepared) == secrets(source)

def blocks(text):
    return [textwrap.dedent(body) for body in re.findall(r"^          python3 - <<'PY'\n(.*?)^          PY$", text, re.M | re.S)]
original_blocks, prepared_blocks = blocks(source), blocks(prepared)
assert len(original_blocks) == len(prepared_blocks) == 7
for i, block in enumerate(prepared_blocks):
    compile(block, f'cleanup-inline-{i + 1}', 'exec')
def definition(all_blocks, name):
    for block in all_blocks:
        for node in ast.walk(ast.parse(block)):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == name:
                return ast.get_source_segment(block, node)
    raise AssertionError(name)
for name in ('download_archive', 'verified_receipt', 'stamp', 'check_window'):
    assert definition(original_blocks, name) == definition(prepared_blocks, name), name

roundtrip = prepared.replace(guard, '', 1)
for change in reversed(replacements):
    assert roundtrip.count(change['new']) == change['occurrences'], change
    roundtrip = roundtrip.replace(change['new'], change['old'])
assert roundtrip.encode() == original

target = out / 'bundle/.github/workflows/issue1505-smoke-github-readonly.yml.in'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(prepared.encode())
def meta(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}
bindings = {'status': 'offline_unbound_disabled', 'branch': branch, 'go': go,
            'values': dict.fromkeys(fields), 'markers': fields,
            'requiredPrepareBranch': branch, 'requiredPrepareRunAttempt': 1,
            'closedParentMeaning': 'the NEW prepare entry-close commit, sole parent of cleanup',
            'currentMainMeaning': 'actual main at cleanup handoff; may differ from prepare main',
            'jobMinutesPermittedByOriginalGuard': {'min': 1, 'max': 15},
            'originalReviewedJobMinutes': 10,
            'workflowJobIf': False, 'reviewedJobIfAfterBinding': enabled_if,
            'activationAuthorizedByThisPackage': False}
verification = {
    'sourceCommit': 'e5a50fa1d227eca754eb41dc0fc39a14ffd5d377',
    'sourceUrl': 'https://github.com/alexj11324/Mikka/blob/e5a50fa1d227eca754eb41dc0fc39a14ffd5d377/.github/workflows/issue1505-smoke-github-readonly.yml',
    'originalWorkflow': meta(original), 'preparedWorkflow': meta(prepared.encode()),
    'pythonBlocksCompiledWithoutExecution': 7, 'newTestsRun': 0,
    'runtimeOrNetworkStatementsExecuted': False, 'all19BindingsUnfilled': True,
    'unfilledGuardBeforeAnyNetworkOrCredentials': True, 'jobDisabled': True,
    'threeCurrentMainGetsRetained': True, 'sevenWindowCallsRetained': True,
    'twoExistingQueuesRetained': True, 'fiveSecretActionBlockByteIdentical': True,
    'downloadArchiveFunctionByteIdentical': True, 'verifiedReceiptFunctionByteIdentical': True,
    'windowFunctionByteIdentical': True, 'singleClosedParentAndWorkflowOnlyDiffGuardRetained': True,
    'existingFiveHelpersUsedWithoutFurtherChanges': True,
    'reverseAllAllowedReplacementsMatchesOriginalBytes': True,
    'replacements': replacements,
}
(out / 'bindings.unfilled.json').write_text(json.dumps(bindings, indent=2) + '\n')
(out / 'provenance/static-verification.json').write_text(json.dumps(verification, indent=2) + '\n')
(out / 'provenance/workflow-preparation.patch').write_text(''.join(difflib.unified_diff(
    source.splitlines(keepends=True), prepared.splitlines(keepends=True),
    fromfile='e5a/.github/workflows/issue1505-smoke-github-readonly.yml',
    tofile='cleanup/bundle/.github/workflows/issue1505-smoke-github-readonly.yml.in')))
print(json.dumps({'workflow': str(target), **meta(prepared.encode()), 'pythonBlocksCompiled': 7,
                  'testsRun': 0, 'bindingsUnfilled': len(fields), 'disabled': True}))
