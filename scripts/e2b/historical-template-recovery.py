"""Recover only this issue's exact template IDs from immutable creation logs."""
import importlib.util
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', HERE / 'build-template.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
inventory = json.loads((HERE / 'historical-template-inventory.json').read_text())
templates = inventory['templates']
if len(templates) != 25 or len({row['templateId'] for row in templates}) != 25:
    raise ValueError('historical_inventory_count_mismatch')
candidates = []
for row in templates:
    if (row['runAttempt'] != 1 or not re.fullmatch(r'[a-f0-9]{40}', row['sourceCommit'])
            or row['alias'] != f"mikka-1505-{row['category']}-{row['runId']}-1-{row['kind']}"
            or row['category'] not in ('component', 'official-control')
            or row['evidence']['source'] != 'github_sdk_creation_logs'):
        raise ValueError('historical_inventory_identity_mismatch')
    candidates.append({'kind': row['kind'], 'name': row['alias'], 'templateId': row['templateId']})
requests = []
def request(method, path, key):
    try:
        result = builder._request(method, path, key)
        requests.append({'method': method, 'path': path, 'status': 204 if method == 'DELETE' else 200})
        return result
    except HTTPError as error:
        requests.append({'method': method, 'path': path, 'status': error.code})
        raise
key = os.environ['E2B_API_KEY']
first = builder.cleanup_templates(candidates, key, request)
second = builder.cleanup_templates(candidates, key, request)
report = {'version': 1, 'sourceInventory': 'ops/1505-template-benchmark SDK creation logs',
          'workflowSource': os.environ['GITHUB_SHA'], 'runId': os.environ['GITHUB_RUN_ID'],
          'templates': first, 'readback': second, 'requests': requests}
Path(os.environ['RUNNER_TEMP'], 'historical-template-recovery.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, separators=(',', ':')), flush=True)
if any(row['status'] == 'failed' for row in first + second): raise SystemExit(1)
