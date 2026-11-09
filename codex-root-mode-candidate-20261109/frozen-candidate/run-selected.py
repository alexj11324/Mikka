import datetime
import hashlib
import json
import pathlib
import platform
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent
PHASE = sys.argv[1]
assert PHASE in ('red', 'green')
TESTS = [
    'CodexRootCaFinalization',
    'OfficialFiles.test_exact_root_ca_exception_keeps_type_owner_target_mode_and_other_paths_protected',
    'OfficialFiles.test_provider_ca_finalization_keeps_exact_path_type_owner_and_mode_guards',
    'OfficialFiles.test_rotating_provider_ca_bytes_are_accepted_only_at_fresh_finalization',
    'OfficialFiles.test_exact_root_ca_rotation_receipts_reject_invalid_hashes',
]
CWD = ROOT / 'candidate'
COMMAND = [sys.executable, 'scripts/e2b/official-files.test.py', '-v', *TESTS]
PREFIX = ROOT / 'evidence' / PHASE
assert not PREFIX.with_suffix('.result.json').exists(), 'Do not overwrite an actual result'
sources = []
for name in ('official-files.py', 'official-files.test.py', 'e2b-finalization-files.json', 'e2b-certificate-relinks.json'):
    path = CWD / 'scripts/e2b' / name
    data = path.read_bytes()
    sources.append({'path': str(path.relative_to(CWD)), 'bytes': len(data),
                    'sha256': hashlib.sha256(data).hexdigest(),
                    'gitBlobOid': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()})
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
began = time.monotonic()
result = subprocess.run(COMMAND, cwd=CWD, capture_output=True, check=False)
elapsed = time.monotonic() - began
for suffix, data in (('.stdout.txt', result.stdout), ('.stderr.txt', result.stderr)):
    PREFIX.with_suffix(suffix).write_bytes(data)
metadata = {'phase': PHASE, 'command': COMMAND, 'cwd': str(CWD), 'startedAt': started,
            'elapsedSeconds': elapsed, 'exitCode': result.returncode,
            'pythonVersion': platform.python_version(), 'executable': sys.executable,
            'sourceFiles': sources,
            'stdout': {'bytes': len(result.stdout), 'sha256': hashlib.sha256(result.stdout).hexdigest()},
            'stderr': {'bytes': len(result.stderr), 'sha256': hashlib.sha256(result.stderr).hexdigest()},
            'scope': 'Four new Codex methods and four directly related existing methods; no provider or filesystem scan'}
PREFIX.with_suffix('.result.json').write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
sys.stdout.buffer.write(result.stdout)
sys.stdout.buffer.write(result.stderr)
print(json.dumps({'phase': PHASE, 'exitCode': result.returncode, 'result': str(PREFIX.with_suffix('.result.json'))}))
sys.exit(result.returncode)
