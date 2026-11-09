# Publication kind contract regression — 2026-11-09

This local candidate repairs the Node publication consumer and its obsolete Codex fixture. It contains no Git commit, ref update, workflow activation, cloud operation, or production acceptance result.

## Exact source and change

`original/` is a byte-for-byte snapshot of the dependency closure needed by the complete publication test, copied from the current files in `/workspace/scratch/263e36984c81/Mikka-1505-ca-relinks`. That working tree was supplied by the parent as the cb2 candidate; its local Git HEAD was not used as a source identity. `source-bindings.json` records every copied file's bytes, SHA-256 and Git blob OID. The original root files were reread after validation and all 16 still matched the snapshot.

Only these two files differ in `candidate/`:

- `scripts/e2b/publish-template-env.mjs`: one conditional rejects a provider change when an existing policy `_kind` is present and differs from the receipt's outer `change.kind`.
- `scripts/e2b/publish-template-env.test.mjs`: updates the obsolete Codex `0644 -> 0777` rejection to the still-forbidden `0644 -> 0755`; adds the official Codex digest pair and mode-only positive; exercises both policy kinds with valid, absent, null, link, swapped file/directory, and numeric outer kinds.

The existing negative cases for mode, uid, gid, actual file-kind transitions, other certificate paths, and CLI paths remain. Existing strict installation, source binding, subscription, publication, and network-fixture tests remain. The policy, Python matcher, certificate list and all other copied source files are unchanged.

The producer emits the original entry kind at the outer `change.kind`; unchanged kind does not appear in the changed-fields dictionaries. The generic consumer check therefore uses that outer field. It applies to the two existing `_kind` rules: Claude `/usr/local/share/e2b` must be a directory; Codex `/usr/local/share/ca-certificates/e2b-ca.crt` must be a file. Rules without `_kind` retain their existing behavior.

## Actual validation

All runs used Node v24.22.1 and the already installed `tsx` dependency through a local read-only resolution symlink. No package installation, credentials, real network request, VM, model request, or subscription was used. The test's existing HTTP fixtures were retained.

Command, from `candidate/`:

```sh
node --import tsx --test --test-reporter=tap scripts/e2b/publish-template-env.test.mjs
```

| Phase | Source used | Pass | Fail | Skip |
| --- | --- | ---: | ---: | ---: |
| Baseline RED | Original publisher and original full test | 24 | 1 | 0 |
| Guard RED | Original publisher and updated full test | 27 | 2 | 0 |
| GREEN | One-line publisher guard and updated full test | 29 | 0 | 0 |

Baseline RED reproduces the obsolete assertion at original test line 180. Guard RED fails the Claude and Codex kind tests at their first absent-kind assertion; it is not a claim that subsequent loop variants were reached during RED. GREEN executes all five forbidden kinds per policy rule successfully. The complete stdout, stderr, command, source hashes, start/end times and exit codes are preserved under `validation/`. `run-validation.py` is the actual guard-RED/GREEN runner and refuses to overwrite an existing result.

Codex fixture values come from the already reviewed official-only run 42670291715: `713ed37b...` stays unchanged across pre-finalization to ready while mode changes 420 to 511; fresh has digest `545244c4...`. These tests construct publication receipts from those known values. They do not reread an artifact, run a new control, replay a whole filesystem, or establish real release/subscription success.

## Review artifacts

`candidate.patch` is the complete two-file patch. `review-receipt.json` binds every phase to the exact source bytes and records the limitations. `manifest.json` lists all regular payload files; the local `candidate/node_modules` resolution symlink is deliberately not payload and must not be archived as dependency contents.

The candidate is frozen after the recorded GREEN. No additional tests were run.
