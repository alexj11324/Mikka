#!/usr/bin/env python3
"""Offline adaptation of frozen diagnostic drafts; never binds or activates them."""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path

BRANCH = 'ops/1505-smoke-github-readonly-20261109'
PREPARE_BRANCH = 'ops/1505-diagnostic-prepare-r7-20261109'
CLEANUP_BRANCH = 'ops/1505-diagnostic-cleanup-r7-20261109'
PREPARE_WF = '.github/workflows/issue1505-diagnostic-window.yml.in'
CLEANUP_WF = '.github/workflows/issue1505-diagnostic-cleanup-r7.yml.in'
PINNED = {
    'diagnostic-prepare-materialize-v2-1505.py': '83adf25ec41bf209a719b24b9cc9640c6ed2fc72979a498ed7a21c7718322456',
    'diagnostic-prepare-preparation-1505/' + PREPARE_WF: '0d6120d027159051a39c9e1cf720d5429d21a91f24048753da0e20ff51835a81',
    'diagnostic-prepare-preparation-1505/scripts/ops/issue1505-diagnostic-window.mjs.in': '53a39063ea55939b9f4f2caf916e429adc21e43a5990b8d62c2952f119032928',
    'diagnostic-prepare-preparation-1505/scripts/ops/issue1505-diagnostic-window-original-42366750743.json': '12f6f3758c382dd55c9055b3ab32f9d785c620594c66ad4d49a2030b3ccda8d5',
    'diagnostic-prepare-preparation-1505/pins.unfilled.json': 'b7b6080cb1db54e1c521014fcece66549876afa4e3e7cfdc28017397736ca5c3',
    'diagnostic-cleanup-preparation-1505/' + CLEANUP_WF: '5a7dd07d34b69fe8f8615a3ef65791bb4221532fe69c05e73a3bcfe194891e19',
    'diagnostic-cleanup-preparation-1505/scripts/ops/issue1505-diagnostic-cleanup-r7.mjs': '46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c',
    'diagnostic-cleanup-preparation-1505/bindings.unfilled.json': '901b5e690cd70f4115022206d80f43f738b258f6f6f15568632deceaec99e05d',
}

def identity(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'gitBlob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()}

def inventory(base):
    paths = [base / 'diagnostic-prepare-materialize-v2-1505.py']
    for name in ('diagnostic-prepare-preparation-1505', 'diagnostic-cleanup-preparation-1505'):
        paths.extend(p for p in (base / name).rglob('*') if p.is_file())
    result = []
    for path in sorted(paths):
        if path.is_symlink():
            raise ValueError('source_symlink_refused')
        result.append({'path': str(path.relative_to(base)), **identity(path.read_bytes())})
    return result

def replace_exact(text, old, new, count):
    if text.count(old) != count:
        raise ValueError('source_anchor_count_mismatch: ' + old[:80])
    return text.replace(old, new)

def adapt_prepare(text):
    text = replace_exact(text, PREPARE_BRANCH, BRANCH, 2)
    text = replace_exact(text,
        "      HELPER_PARENT_TREE: '__HELPER_PARENT_TREE__'\n",
        "      HELPER_PARENT_TREE: '__HELPER_PARENT_TREE__'\n      CLOSED_CARRIER_PARENT: '__CLOSED_CARRIER_PARENT__'\n", 1)
    text = replace_exact(text,
        "            check(e.HELPER_PARENT===e.EXPECTED_APP_SOURCE&&e.HELPER_PARENT_TREE===e.EXPECTED_APP_TREE,'parent_pin_mismatch')\n",
        "            check(e.HELPER_PARENT===e.EXPECTED_APP_SOURCE&&e.HELPER_PARENT_TREE===e.EXPECTED_APP_TREE,'parent_pin_mismatch')\n"
        "            check(/^[0-9a-f]{40}$/.test(e.CLOSED_CARRIER_PARENT??'')&&e.CLOSED_CARRIER_PARENT!==e.HELPER_PARENT,'carrier_parent_invalid')\n", 1)
    text = replace_exact(text,
        "            check(parents.length===1&&parents[0]===e.HELPER_PARENT,'helper_parent_mismatch')",
        "            check(parents.length===2&&parents[0]===e.HELPER_PARENT&&parents[1]===e.CLOSED_CARRIER_PARENT,'helper_parent_mismatch')", 1)
    return text

def adapt_cleanup(text):
    text = replace_exact(text, CLEANUP_BRANCH, BRANCH, 3)
    text = replace_exact(text, '    env:\n      CLEANUP_BINDINGS_JSON: |\n',
        "    env:\n      CLOSED_CARRIER_PARENT: '__CLOSED_CARRIER_PARENT__'\n      CLEANUP_BINDINGS_JSON: |\n", 1)
    text = replace_exact(text, '           const e=process.env;\n',
        "           const e=process.env;\n           must(/^[a-f0-9]{40}$/.test(e.CLOSED_CARRIER_PARENT??'')&&e.CLOSED_CARRIER_PARENT!==pins.currentMainCommit,'bindings_invalid');\n", 2)
    text = replace_exact(text,
        "           must(git('rev-parse','HEAD')===e.GITHUB_SHA&&git('show','-s','--format=%P','HEAD')===pins.currentMainCommit,'source_identity_invalid');",
        "           must(git('rev-parse','HEAD')===e.GITHUB_SHA&&git('show','-s','--format=%P','HEAD')===`${pins.currentMainCommit} ${e.CLOSED_CARRIER_PARENT}`,'source_identity_invalid');", 2)
    return text

def materialize(base, out):
    base, out = base.resolve(), out.resolve()
    if out == base or any((out / name).exists() for name in ('prepare', 'cleanup', 'provenance', 'diffs')):
        raise ValueError('existing_output_refused')
    before = inventory(base)
    for path, wanted in PINNED.items():
        if identity((base / path).read_bytes())['sha256'] != wanted:
            raise ValueError('source_hash_mismatch: ' + path)
    module = ast.parse((base / 'diagnostic-prepare-materialize-v2-1505.py').read_text())
    literals = {node.targets[0].id: ast.literal_eval(node.value) for node in module.body
                if isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name) and node.targets[0].id in ('WORKFLOW', 'README')}
    old_prepare = (base / 'diagnostic-prepare-preparation-1505' / PREPARE_WF).read_text()
    old_cleanup = (base / 'diagnostic-cleanup-preparation-1505' / CLEANUP_WF).read_text()
    if literals['WORKFLOW'] != old_prepare:
        raise ValueError('v2_frozen_workflow_mismatch')
    if literals['README'] != (base / 'diagnostic-prepare-preparation-1505/README.md').read_text():
        raise ValueError('v2_frozen_readme_mismatch')
    prepare = adapt_prepare(old_prepare)
    cleanup = adapt_cleanup(old_cleanup)
    outputs = {
        'prepare/' + PREPARE_WF: prepare.encode(),
        'cleanup/' + CLEANUP_WF: cleanup.encode(),
    }
    for name, files in {
        'prepare': ['pins.unfilled.json', 'scripts/ops/issue1505-diagnostic-window.mjs.in',
                    'scripts/ops/issue1505-diagnostic-window-original-42366750743.json'],
        'cleanup': ['bindings.unfilled.json', 'scripts/ops/issue1505-diagnostic-cleanup-r7.mjs'],
    }.items():
        source = base / ('diagnostic-' + name + '-preparation-1505')
        for file in files:
            outputs[name + '/' + file] = (source / file).read_bytes()
        outputs[name + '/carrier.unfilled.json'] = b'{\n  "closedCarrierCommit": null\n}\n'
    pins = json.loads(outputs['prepare/pins.unfilled.json'])
    if len(pins) != 13 or any(value is not None for value in pins.values()):
        raise ValueError('original_13_pins_not_unfilled')
    for name, old, new, path in (
        ('prepare', old_prepare, prepare, PREPARE_WF),
        ('cleanup', old_cleanup, cleanup, CLEANUP_WF),
    ):
        outputs['diffs/' + name + '.diff'] = ''.join(difflib.unified_diff(
            old.splitlines(True), new.splitlines(True),
            fromfile='frozen/' + path, tofile='trusted-carrier/' + path)).encode()
    outputs['provenance/source-inventory.before.json'] = (json.dumps(before, indent=2) + '\n').encode()
    outputs['provenance/adaptation.json'] = (json.dumps({
        'version': 1, 'branch': BRANCH, 'closedCarrierCommit': None,
        'orderedParents': [None, None], 'firstParentMeaning': 'fresh exact APP',
        'secondParentMeaning': 'fresh independently verified closed carrier head; root performs expected-head normal FF',
        'originalPreparePins': 13, 'extraStructuralBinding': 'CLOSED_CARRIER_PARENT, from per-operation carrier.unfilled.json',
        'prepareHelperBytesPreserved': True, 'cleanupHelperBytesPreserved': True,
        'oldHelperCliExecuted': False, 'v2WorkflowLiteralMatchesFrozen': True,
        'rootTrustBasis': 'root supplied actual successful same-identity carrier branch; no new OIDC probe or rule change',
        'actualOidcTrustForFutureRun': 'not exercised',
        'relativeToApp': {'prepare': 'exactly original 3 added paths, mode 100644', 'cleanup': 'exactly original 2 added paths, mode 100644'},
        'activated': False, 'refCreated': False, 'cloudCalls': 0,
    }, indent=2) + '\n').encode()
    for path, data in outputs.items():
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)
    after = inventory(base)
    if before != after:
        raise ValueError('frozen_source_changed')
    (out / 'provenance/source-inventory.after.json').write_text(json.dumps(after, indent=2) + '\n')
    print(json.dumps({'status': 'prepared_disabled', 'filesWritten': len(outputs) + 1,
                      'frozenSourcesUnchanged': True, 'sourceFiles': len(before), 'out': str(out)}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    materialize(args.source_root, args.out)
