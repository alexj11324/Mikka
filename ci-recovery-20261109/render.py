from pathlib import Path
import ast
import hashlib
import json
import yaml

root = Path(__file__).parent
source = (root / "recovery_source.py").read_text()
ast.parse(source)
workflow = '''name: Issue 1505 bounded CI recovery

on:
  push:
    branches: [ops/1505-smoke-github-readonly-20261109]
    paths: [.github/workflows/issue1505-ci-recovery.yml]

permissions:
  contents: read
  pull-requests: read
  actions: write

concurrency:
  group: issue1505-ci-recovery
  cancel-in-progress: false
  queue: max

jobs:
  recover:
    if: false
    runs-on: ubuntu-22.04
    timeout-minutes: 5
    env:
      RECOVERY_GO: 'false'
      RECOVERY_NOT_BEFORE: __START__
      RECOVERY_ENTRY_DEADLINE: __ENTRY__
      RECOVERY_DEADLINE: __HARD__
    steps:
      - name: Check out the exact operator
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: ${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Retry only the five exact zero-job failures once
        timeout-minutes: 4
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          python3 -B - <<'PY'
'''
workflow += ''.join('          ' + line + '\n' for line in source.splitlines())
workflow += '''          PY
      - name: Preserve request intents and independent outcomes
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: issue1505-ci-recovery-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/issue1505-ci-recovery/
          if-no-files-found: warn
          retention-days: 7
'''
yaml.safe_load(workflow)
(root / "workflow.yml.in").write_text(workflow)
print(json.dumps({"bytes": len(workflow.encode()), "sha256": hashlib.sha256(workflow.encode()).hexdigest(), "active": False}))
