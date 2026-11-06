"""Recover only exact images from one completed failed main release run."""
import importlib.util
import json
import os
from pathlib import Path
from urllib.error import HTTPError
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
templates = json.loads((HERE / 'completed-template-inventory.json').read_text())
expected = {'42307542412': 'b8045b5661bcbf51eeecc74ceef19eceead93a10'}
if len(templates) != 3 or len({row['templateId'] for row in templates}) != 3:
    raise ValueError('completed_inventory_count_mismatch')
for run_id, source in expected.items():
    request = urllib.request.Request('https://api.github.com/repos/alexj11324/Mikka/actions/runs/' + run_id,
        headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'], 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=30) as response: run = json.load(response)
    if run['status'] != 'completed' or run['conclusion'] != 'failure' or run['head_sha'] != source or run['run_attempt'] != 1:
        raise ValueError('release_run_not_completed_failed_identity')
for row in templates:
    if (row['sourceCommit'] != expected.get(row['runId']) or row['runAttempt'] != '1'
            or row['name'] != f"mikka-{row['sourceCommit'][:12]}-{row['runId']}-1-{row['kind']}"):
        raise ValueError('completed_inventory_identity_mismatch')
requests = []
def request(method, path, key):
    try:
        result = builder._request(method, path, key)
        requests.append({'method': method, 'path': path, 'status': 204 if method == 'DELETE' else 200})
        return result
    except HTTPError as error:
        requests.append({'method': method, 'path': path, 'status': error.code})
        raise
first = builder.cleanup_templates(templates, os.environ['E2B_API_KEY'], request)
second = builder.cleanup_templates(templates, os.environ['E2B_API_KEY'], request)
report = {'version': 1, 'workflowSource': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
          'scope': expected, 'templates': first, 'readback': second, 'requests': requests}
Path(os.environ['RUNNER_TEMP'], 'completed-template-recovery.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, separators=(',', ':')), flush=True)
if any(row['status'] == 'failed' for row in first + second): raise SystemExit(1)
