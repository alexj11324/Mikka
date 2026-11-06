#!/usr/bin/env bash
# Runs only inside the existing task-owned Docker sandbox, through normal exec.
set -euo pipefail
umask 077
test "$#" -eq 6
MIKKA_VERIFY_MANIFEST="$1"
MIKKA_VERIFY_STOP="$2"
MIKKA_VERIFY_LIVE="$3"
MIKKA_VERIFY_RUNNER="$4"
MIKKA_VERIFY_REPORT="$5"
MIKKA_VERIFY_WORKTREE="$6"
MIKKA_VERIFY_PHASE=arguments
[[ "$MIKKA_VERIFY_WORKTREE" =~ ^/workspace/Mikka-1506-verify-[0-9]{1,24}-[0-9]{1,4}$ ]]
[[ "$MIKKA_VERIFY_REPORT" =~ ^/tmp/mikka-1506-[0-9]{1,24}-[0-9]{1,4}-report.json$ ]]
trap 'MIKKA_VERIFY_EXIT=$?; if [ "$MIKKA_VERIFY_EXIT" -ne 0 ] && [ ! -f "$MIKKA_VERIFY_REPORT" ]; then python3 - "$MIKKA_VERIFY_REPORT" "$MIKKA_VERIFY_PHASE" "$MIKKA_VERIFY_EXIT" <<"PY"
import json, sys
from pathlib import Path
value={"schemaVersion":1,"status":"failed","phase":sys.argv[2],"error":"remote_setup_failed","exitCode":int(sys.argv[3])}
Path(sys.argv[1]).write_text(json.dumps(value)+"\n")
print(json.dumps(value))
PY
fi' EXIT

MIKKA_VERIFY_PHASE=manifest
python3 - "$MIKKA_VERIFY_MANIFEST" "$MIKKA_VERIFY_STOP" "$MIKKA_VERIFY_LIVE" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
manifest=json.loads(Path(sys.argv[1]).read_text())
assert manifest['schemaVersion']==1 and manifest['baseSha']=='e8dd7a1265027a0477819dde1a80178e7bcdb1ae'
assert len(manifest['patches'])==2
seen=set()
for item, name, path in zip(manifest['patches'], ['stop.patch','live.patch'], sys.argv[2:]):
    assert item['file']==name and hashlib.sha256(Path(path).read_bytes()).hexdigest()==item['sha256']
    for relative, expected in item['sources'].items():
        assert re.fullmatch(r'(lib|hooks|scripts|workflows)/[A-Za-z0-9_./-]+\.(ts|tsx|mjs)',relative) and '..' not in relative
        assert relative not in seen and re.fullmatch(r'[0-9a-f]{64}',expected)
        seen.add(relative)
PY
MIKKA_VERIFY_PHASE=worktree
test ! -e "$MIKKA_VERIFY_WORKTREE"
git -C /workspace/Mikka cat-file -e 'e8dd7a1265027a0477819dde1a80178e7bcdb1ae^{commit}'
git -C /workspace/Mikka worktree add --detach "$MIKKA_VERIFY_WORKTREE" e8dd7a1265027a0477819dde1a80178e7bcdb1ae >/dev/null 2>/dev/null
cd "$MIKKA_VERIFY_WORKTREE"
cmp pnpm-lock.yaml /workspace/Mikka/pnpm-lock.yaml >/dev/null
cmp package.json /workspace/Mikka/package.json >/dev/null
MIKKA_VERIFY_PHASE=patches
git apply --check "$MIKKA_VERIFY_STOP"
git apply --index "$MIKKA_VERIFY_STOP"
git apply --check "$MIKKA_VERIFY_LIVE"
git apply --index "$MIKKA_VERIFY_LIVE"
test -d /workspace/Mikka/node_modules
ln -s /workspace/Mikka/node_modules node_modules
python3 - "$MIKKA_VERIFY_WORKTREE" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for group in ('apps','packages'):
    for source in (Path('/workspace/Mikka')/group).glob('*/node_modules'):
        destination=root/group/source.parent.name/'node_modules'
        if destination.parent.is_dir() and not destination.exists() and not destination.is_symlink():
            destination.symlink_to(source, target_is_directory=True)
PY
MIKKA_VERIFY_PHASE=bootstrap
# The original checkout owns the already installed dependency stamp. Capture
# exports without printing them; failure is checked before evaluation.
MIKKA_VERIFY_BOOTSTRAP="$(/workspace/Mikka/scripts/dev/bootstrap-local.sh 2>"$MIKKA_VERIFY_REPORT.bootstrap-stderr")"
eval "$MIKKA_VERIFY_BOOTSTRAP"
unset MIKKA_VERIFY_BOOTSTRAP
MIKKA_VERIFY_PHASE=checks
node "$MIKKA_VERIFY_RUNNER" "$MIKKA_VERIFY_MANIFEST" "$MIKKA_VERIFY_REPORT" "$MIKKA_VERIFY_WORKTREE"
