# Local verification of the 1217 / main-40d integration

The normal dual-parent merge is held locally as `9441896ad27e0f072d11dc24194351623327a2ac`, parents `cccef174f7a4e604a820a4b61f8521e8cdba100b` and `40d03479ea8260b8934f609b84c7c9cb60a94b3c`, exact tree `de3b83d85361e39a33ca9e5678d4ed37e6a33fe4`. A later GitHub-created merge commit can have different metadata; its tree and both parents must match. The public PR ref was not moved while these results were obtained.

## Exact results

| Gate | Actual result |
| --- | --- |
| Cloud limits / retained deliverable | 29/29 and 11/11, no skips |
| Task machine, original question VM upgrades, stop, first-Bot metadata, cloud admission, fallback and run-end PG | 119/119, no skips |
| Factory checks, continuity, inherited command observations and original execution continuation PG | 138/138, no skips |
| Next typegen | exit 0 |
| Repository `pnpm typecheck` | exit 0 |
| `oxlint --deny-warnings` | exit 0 |
| Diff check against actual main 40d | exit 0 |

Product blobs did not change between the first and second gate runs. The existing passing unit/type/lint results are reused only for that unchanged tree. The corrected PostgreSQL runs finished at `2026-11-05T01:58:08.312Z`; raw commands, PIDs, durations and exit codes are recorded in `gate-proof/manifest.json`.

The new #1301 PostgreSQL cases retain real migrated storage and exercise queued execute/review/verify upgrades on the original VM, original native SID and answer receipt; epoch/attempt/stage/receipt/stop/claim/lease/workspace races; and rollback/retry of the same child. Provider I/O is fixture-controlled. These are local integration checks, not real provider or model acceptance.

## Retained failures and the actual correction

1. The image's default `pnpm` was 11.28.10, while the repository requires 10.34.3. The first frozen install failed with `ERR_PNPM_IGNORED_BUILDS`. It was retained; the normal `corepack pnpm install --frozen-lockfile` using 10.34.3 then succeeded. No build allowlist or repository package declaration was changed.
2. The first external gate runner incorrectly set `BETTER_AUTH_URL=https://example.invalid/mikka`. `createAuthEmail` requires a bare origin, so imports failed with `Invalid authentication email origin`. This yielded task PG 63/73 and Factory PG 62/65, and both failures are preserved. The runner was corrected to `https://example.invalid` and only the affected two PG groups were re-run with a new role/database. No auth check, CI/local-mode flag, assertion or product file was changed. This is an environment correction, not a claimed product RED-to-GREEN fix.
3. Diff-check against the old PR head reports four trailing blank lines introduced by incoming #1301 files. The complete incoming main was retained. Diff-check against the actual PR base main 40d passes; those existing main whitespace changes were not folded into an unrelated cleanup.

## Isolation and cleanup

Both PG runs used the existing loopback PostgreSQL 17 service and a new random-password temporary login role with CREATEDB, plus a unique role-owned `_e2e` database. Child database URLs were all set to that isolated target. No production URL, provider credential or test account was used, and no application server was started. Random passwords were created in the runner process and passed in child environments, never written to these artifacts.

Cleanup used the **existing local admin connection** to enumerate only databases owned by that run's temporary role, required each name to end in `_e2e`, and executed scoped **`DROP DATABASE ... WITH (FORCE)`** before dropping that role. This was not a claim of ordinary non-forced DROP or pre-observed zero connections. No existing role gained privileges and no production database or unrelated local role/database was changed. The original and corrected receipts both explicitly confirm all enumerated own databases and their temporary role are absent.

## Publication boundary

The source candidate has exactly the prior PR's 27 paths: 26 content files and the deletion of `lib/factory/cloud-stage-admission.ts`. The seven #1302 release files and main's `thread-worker-logs.ts` remain identical to main. The full source manifests and both parent-relative diffs are in `candidate/`; `BOUNDARIES.md` explains the five conflict choices.

Exact-head CI must follow the eventual public ref update. The paid local-loop cloud leg and three real user-model paths remain unmet and are not replaced by these results. The PR remains unmerged pending those original gates.
