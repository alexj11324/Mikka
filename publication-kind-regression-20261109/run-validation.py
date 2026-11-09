"""Run only the copied publication test file and retain complete local evidence."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

base = Path(__file__).resolve().parent
phase = sys.argv[1]
if phase not in {'guard-red', 'green'}:
    raise SystemExit('unknown validation phase')
prefix = base / 'validation' / phase
if prefix.with_suffix('.result.json').exists():
    raise SystemExit('refusing to overwrite a validation result')


def metadata(data):
    return {
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'gitBlobOid': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(),
    }


node = shutil.which('node')
environment = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'TSX_DISABLE_CACHE': '1'}
command = [node, '--import', 'tsx', '--test', '--test-reporter=tap', 'scripts/e2b/publish-template-env.test.mjs']
bindings = json.loads((base / 'source-bindings.json').read_text())
sources = {row['path']: metadata((base / 'candidate' / row['path']).read_bytes())
           for row in bindings['copiedDependencyClosure']}
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = subprocess.run(command, cwd=base / 'candidate', env=environment, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, timeout=60)
prefix.with_suffix('.stdout.txt').write_bytes(result.stdout)
prefix.with_suffix('.stderr.txt').write_bytes(result.stderr)
receipt = {
    'phase': phase,
    'command': command,
    'cwd': str(base / 'candidate'),
    'environmentKeys': list(environment),
    'nodeVersion': subprocess.check_output([node, '--version'], env=environment, text=True).strip(),
    'startedAt': started,
    'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'exitCode': result.returncode,
    'stdout': metadata(result.stdout),
    'stderr': metadata(result.stderr),
    'source': sources,
}
prefix.with_suffix('.result.json').write_text(json.dumps(receipt, indent=2) + '\n')
summary = [line for line in result.stdout.decode().splitlines()
           if line.startswith(('not ok', '# tests ', '# pass ', '# fail ', '# skipped ', '# cancelled '))]
print(json.dumps({'phase': phase, 'exitCode': result.returncode, 'summary': summary, 'stderr': result.stderr.decode()}))
