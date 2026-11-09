# Claude conservation integration evidence (2026-11-09)

## Fixed tested source

- Source merge commit: 869c71d7aa062c76fc7a75c1f8775d1ed8538168.
- Tested tree: 61207b65e30026c0cde5cd4eb9b794cb4faf308e.
- Ordered parents: 2c3edf02d630c88b092f21db47b6f312a3c26f96, 8b9dea4b85a9ffe13dab5687774664e1a49a336e.
- Actual Linux Git merge-base: 02401458a7fe26e00ce4caa653084c7f9680696d.
- Published product comparison baseline: e78fccffd9dd878edd490b113ea80efcff1525e7.

The temporary Linux VM performed a real anonymous HTTPS Git fetch of both fixed
commits, then git merge --no-commit --no-ff. There was no conflict. Git write-tree
and the independently created GitHub Git tree both produced the tested tree.
The 10 paths from the startup branch and 5 paths from the Claude fix were
disjoint. Relative to e78, the combined tree changed exactly those 15 paths.
Each side's blob and mode was preserved. No other product delta was added.
See tree-proof.json, phase1.json, the Git command logs, and source-commit-readback.json.

## Actual validation

Environment: Node 24.22.1, pnpm 10.34.3, Git 2.49.0, initially Python 3.9.25.
A frozen-lockfile pnpm install succeeded in 51.8 seconds.
Python 3.11.16 was installed for the build-template tests.

- official-files: 25 passed.
- worker-install: 5 passed.
- build-template with Python 3.11.16: 32 passed.
- cleanup-template: 16 passed.
- Final combined Node execution: 186 passed, 0 failed, 0 skipped.
  It ran runtime-report, validate-template-subscriptions, publish-template-env,
  cloud-startup, and web-deploy tests together with the repository's server-only
  and tsx loaders.
- Bootstrap bash -n and staged git diff --check passed.
- pnpm check FAILED. Its test:abuse lane reached lib/abuse/zerocat.test.ts and
  attempted an unconfigured local PostgreSQL connection at 127.0.0.1:5432.
  The observed error was ECONNREFUSED through defaultModelTarget and
  CloudClientStore.capability. No production database was used. This result is
  not a passing full-repository check.

All early failures are retained. The Python 3.9 build-template run had two
errors because Exception.add_note was unavailable. An attempted uv installation
failed because pip was absent. The initial Node run lacked dependencies; after
installation a direct run still lacked the TypeScript loader. The final correct
environment and loader execution passed without changing the tested source.

## Capture and integrity

capture-bundle.json is the exact 262164-byte JSON capture, SHA-256
73d62e27625403488eb09673520a98b7ce8c1e584109efab8974c958b6b12f4d.
It contains 64 captured stdout/stderr, command, and tree-evidence files as base64
with their byte counts and SHA-256 digests. It is NOT a ZIP and is NOT a complete
source-repository archive. Those same 64 original files are also stored
individually, preserving every original byte including empty output files.

The log service initially sampled long streams. The final capture was retrieved
in 15 bounded pieces. Their ordering, complete capture byte length and SHA-256,
and every constituent file's bytes and SHA-256 were independently verified
after reassembly. This archive contains the complete recovered files, not the
initial sampled excerpts.

manifest.json lists every archived file except itself, including its role,
byte count, SHA-256 and Git blob SHA. Its own integrity is bound by the evidence
tree and reported separately in the handoff. VM response and source-readback
files are formatted captures of structured provider responses; they are not
claimed to be raw HTTP wire bytes.

## Resource closure and execution limits

The 2-vCPU, 4-GiB temporary VM was sbx_Jof7ZXv7aRjmEJYigkO2UbrHzAfJ.
STOP completed at 2026-11-09T13:24:50.768Z and a subsequent GET confirmed stopped.
Both responses are archived. No new VM was started to prepare this archive.

The integration task created only an unreferenced source merge object. It did
not update the startup branch, the other owner's branch, or main, and did not
trigger production. This evidence task also creates only unreferenced objects;
the root owner separately controls any evidence-branch fast-forward.

## Merge risk: medium

Alignment: good. The fix addresses the measured Claude directory mode transition
and preserves both branches' bytes without unrelated changes.

Impact: medium. Official-file conservation is a sensitive release gate. The new
rule is limited to the Claude directory /usr/local/share/e2b, kind directory,
mode 0755 to 0777. It performs no chmod. Type, ownership, original child contents,
other paths and templates, strict installation checks, and the original CLI
checks remain protected. No Desktop or APT exception was added.

Verification: decent. Real Linux merge and affected behavior tests passed.
Full pnpm check remains failed for the local database environment gap.
Git-linked CI on the latest combined candidate, complete official-file
conservation, both real subscriptions, and production startup latency are
separate outstanding gates. Targeted control evidence is not release acceptance.

Rollback cost: low. This source integration adds no migration, production
configuration write or data mutation and can be reverted through normal Git.

Error detection: good. Unpermitted finalization changes still fail conservation,
and the additive rule has positive and negative behavior coverage. No validation
error was suppressed or silently converted to success.
