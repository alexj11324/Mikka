"""Validate additive runtime installation on new official instances; never build a template.

E2B_API_KEY stays in this process and is passed only to the SDK. No model prompts
or subscription credentials are used. Each newly created instance is cleaned up.
"""
import argparse
import importlib.util
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('worker_digest', ROOT / 'scripts/e2b/build-template.py')
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)

# Compare file names, link destinations, modes and every regular file's bytes in
# these official installation/configuration roots. This is not an entire-OS claim.
MANIFEST = r'''python3 - <<'PY'
import hashlib,json,pathlib,stat
rows=[]
for base in ['/usr/local','/usr/bin','/home/user/.config']:
 for f in sorted(pathlib.Path(base).rglob('*')):
  s=f.lstat(); row=[str(f),stat.S_IMODE(s.st_mode)]
  if f.is_symlink(): row+=['link',str(f.readlink())]
  elif f.is_file(): row+=['file',hashlib.sha256(f.read_bytes()).hexdigest()]
  elif f.is_dir(): row+=['directory']
  else: continue
  rows.append(row)
print(json.dumps({'entries':len(rows),'sha256':hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()}))
PY'''


def validate(source_ref='HEAD'):
    from e2b import Sandbox
    source_commit = digest.commit(source_ref)
    # Never attest a local working copy as the immutable commit fetched remotely.
    relative = 'packages/daemon/scripts/official-e2b-instance-bootstrap.sh'
    source = subprocess.check_output(['git', 'show', f'{source_commit}:{relative}'], cwd=ROOT, text=True)
    worker_sha = digest.worker_hash(source_commit)
    out = {'sourceCommit': source_commit, 'workerSha': worker_sha, 'templates': {}}
    for kind in ['desktop', 'claude', 'codex']:
        sandbox = Sandbox.create(kind, api_key=os.environ['E2B_API_KEY'], timeout=600,
                                 metadata={'application': 'mikka-official-runtime-validation', 'sourceCommit': source_commit})
        try:
            before = json.loads(sandbox.commands.run(MANIFEST, user='root', timeout=100).stdout)
            sandbox.commands.run(f"bash -s -- {source_commit} {worker_sha} {kind} <<'MIKKA_BOOTSTRAP'\n{source}\nMIKKA_BOOTSTRAP", user='root', timeout=300)
            after = json.loads(sandbox.commands.run(MANIFEST, user='root', timeout=100).stdout)
            if before != after:
                raise RuntimeError(f'official_files_changed {kind}')
            probe = sandbox.commands.run(digest.MODEL_PROBE_COMMAND.format(kind=kind), user='user', timeout=100)
            if probe.exit_code != 0:
                raise RuntimeError('model_probe_failed')
            models = json.loads(probe.stdout)
            for harness in (['claude_code', 'codex'] if kind == 'desktop' else ['claude_code' if kind == 'claude' else 'codex']):
                if not any(row.get('harness') == harness and row.get('installed') is True and (row.get('models') or row.get('modelSlots')) for row in models):
                    raise RuntimeError(f'model_probe_missing {kind} {harness}')
            out['templates'][kind] = {'templateId': kind, 'sandboxId': sandbox.sandbox_id, 'before': before, 'after': after, 'models': models}
        finally:
            sandbox.kill()
    return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-ref', default='HEAD')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(validate(args.source_ref), indent=2) + '\n')
    print('Official instance file conservation and measured model capabilities verified; no subscription acceptance claimed.')
