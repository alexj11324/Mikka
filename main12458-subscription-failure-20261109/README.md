# 12458 runtime release: subscription gate failed, candidates cleaned

These files preserve root's already downloaded originals for [R7 42695935772/A1](https://github.com/alexj11324/Mikka/actions/runs/42695935772), source `12458fe22e1217f644e8b28f82ab856211e73b72`, worker `aa7efbbe2969d8b1578bdba093e6400a26749e07`. No original Actions archive or job log was downloaded again for this archive preparation.

Authenticated read-only run/job metadata confirms: `test`, `check`, `validate / build` and `await-web` succeeded; `subscriptions` failed; `publish` was skipped; `cleanup` succeeded. The metadata is saved in `terminal-metadata.json`.

## Actual failure

Claude Code's complete candidate subscription gate passed, including its bootstrap-adoption receipt. Codex **did not complete the required subscription execution gate**:

- Code: `template_gate_execution_failed`.
- Error: `startup_ended_before_execution_proof`.
- Last observed status: `stopped`.
- A broad successful-tool outcome (`outcome=ok`), expected agent acknowledgement and runtime evidence were observed. This does not prove that a particular README was read.
- `replyVerified` and `replyVerifiedAfterTool` were both **false**.
- Anonymous preparation receipt was unavailable/null; `bindingChecks` was null.

This is different from the preceding source `7848e79...` / run `42690423873`, whose tool and reply passed before `template_gate_bootstrap_adoption_missing` failed its gate. The present source must not inherit that previous run's reply or subscription-pass claim. These diagnostics do not establish why this Codex run stopped before the required reply or who stopped it; the stop actor remains unknown.

Official candidate versions were Claude Code `2.1.312` and Codex `0.167.0`. They remain the original official binaries; this archive contains evidence only. Candidate injection checks do not constitute ordinary Tasks or the issue's full dispatch-to-agent performance acceptance. **No new formal sample passed or was counted.**

## Cleanup and original bytes

The release cleanup original records all three private candidates as deleted: desktop `ipcvgm9336zqe2zv9upv`, Claude `lkzo1t6b60n00fohkh7l`, and Codex `rv0ynz59zc1ufkd6pgsb`. Build cleanup, release cleanup and both candidate diagnostics have empty cleanup-error lists. Publication was skipped.

The three `*.zip.base64.txt` wrappers strictly reconstruct the original ZIP bytes. Each ZIP has exactly its named JSON member, passes CRC, and yields bytes identical to the adjacent original member. Artifact IDs, ZIP and member byte counts and SHA256 hashes are recorded in `zip-original-checks.json` and preserved root readbacks.

`subscriptions-original.log` preserves root's original masked 37028-byte Actions job log, SHA256 `587d7a3e57421055b0602b7fb1544984fbdab4b709f0ced0d470c7bff83a5508`. Its two token-prefix pattern matches are public `e2b_dockerfile_utils` wheel filenames. The performed bounded checks and limitations are recorded in `log-publication-review.json`; the log was not edited.

This archive does not claim that the temporary GitHub child connection was cleaned by the runtime release cleanup. That is a distinct, exact child-cleanup operation with its own receipt.
