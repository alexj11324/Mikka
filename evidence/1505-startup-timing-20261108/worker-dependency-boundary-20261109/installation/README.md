# Worker dependency install boundary — local candidate

## Finding and fix

The two source-024 E2B build attempts failed in a dependency that the worker does not use. Attempt 1 received HTTP 504 for the ffmpeg-static 5.3.0 binary; attempt 2 received HTTP 504 for its LICENSE after the binary download. The root agent owns those original CI logs. This directory does not redownload or duplicate them.

The pinned pnpm 10.34.3 shared-lockfile installation implementation adds the root importer even when `--filter @mikka/daemon...` selects only three workspace packages. The candidate prepares a new private install directory inside the same release. It retains the exact workspace YAML, patches, three package source trees and manifests, and all original locked package/snapshot records. Only the root Web dependencies and unrelated importer blocks are excluded from the derived manifest/lockfile. The original Git source manifest and lockfile stay unchanged. Normal `pnpm install --filter @mikka/daemon... --frozen-lockfile` runs in that private directory with the existing script policy and development dependencies.

The source packages receive relative node_modules links to the installed packages. The private directory remains part of the release because the worker bundle still needs external SDK/pino files. The normal build entry, SDK resolution, CLI finalization, source/worker checks, stage rename, readonly permissions and publish/subscription gates remain intact. The workflow adds only the new Python regression command.

## Actual local verification

- The original filtered synthetic install linked the root-only dependency. Sequential non-recursive installation did not fix it.
- An isolated ignore-workspace/shared-lock fixture excluded root dependencies, but the same command against actual A failed frozen installation because workspace overrides were missing. This option was rejected.
- The actual private workspace installed successfully in an empty owned store with pnpm 10.34.3, in 12.306 seconds. Its projected lockfile remained unchanged. The stdout records the real esbuild postinstall running and completing; no ignore-scripts option was used.
- The installation contains 358 package directories and no ffmpeg-static directory. All 37 declared direct runtime/development links across config, protocol and daemon exist.
- The unchanged worker build command succeeded. Resource checks passed for two entry bundles, nine copied resources, sixteen fixtures and twelve syntax checks, plus the original broker/capability file modes.
- After renaming the entire release, SDK native CLI, pino and esbuild resolve to the same relative paths. A different unprivileged user (nobody) can resolve/read them and has read/execute access to the native CLI.
- Five Python regression cases pass, including source/settings conservation, missing/out-of-closure importer rejection, changed frozen-lock refusal, and an actual stage-to-final directory rename with file reads through all three module links. The existing build-template suite passed 32/32. Shell syntax passed.

## Honest limits and retained failures

The functional build used the base A worker fingerprint solely as a test embedding marker. It is not the new candidate's canonical worker fingerprint. Root will calculate the actual fingerprint after committing the reviewed source and perform the short final build. The local Node runtime is 24.22.1; the official template retains pinned Node 24.19.0.

No E2B template build, official CLI conservation scan, native subscription gate, model invocation, production database operation, API mutation, rerun or publication was performed here. The historical formal six failures remain failures; this work does not add a formal acceptance sample.

The original small tarball fixtures ignored their dependency build scripts, so they are not lifecycle proof. The later actual installation supplies that proof. The first parser unit run found an indentation-matching bug in the initial draft; its raw failure is retained, followed by the corrected result. The first alternate-user check could not invoke runuser from an unprivileged parent; that environment failure is retained. A privileged test launcher subsequently ran the actual read check as nobody successfully. None of these failures were erased or converted into a claimed pass.

Legacy pnpm deploy was considered but not executed: its implementation disables frozenLockfile, so it was rejected for this contract. Blind pnpm retry was rejected separately: the official ffmpeg installer can exit successfully when a binary survives but the LICENSE is missing.

## Source and evidence references

- Base source: `02401458a7fe26e00ce4caa653084c7f9680696d`, tree `0013159d8dd0e1155b84d81907f19f4e1283cff7`.
- Candidate worktree: `/vercel/Mikka-e2b-worker-dependency-boundary`; four candidate files are listed in `candidate-source-final.json`. The parent owns the accompanying ADR edit. This agent did not commit or move a Git ref.
- pnpm root-importer injection: <https://github.com/pnpm/pnpm/blob/v10.34.3/pkg-manager/plugin-commands-installation/src/recursive.ts#L275-L279>.
- Workspace install routing: <https://github.com/pnpm/pnpm/blob/v10.34.3/pkg-manager/plugin-commands-installation/src/installDeps.ts>.
- Supported frozen-install contract: <https://pnpm.io/10.x/cli/install>.
- Maintainer explanation of filtered root dependencies: <https://github.com/pnpm/pnpm/issues/7208>.
- Independent source peer: `/vercel/ops-1505/dependency-projection-review/manifest.json`; its static review does not replace these local installation/build results.
- Install/build/relocation/resource receipts and all failed alternatives are listed by byte length and SHA-256 in this directory's manifest.

The manifest indexes evidence files only. It deliberately excludes downloaded package stores, node_modules, copied checkouts, generated bundles, test fixture package archives, and other reproducible installation material. It does not claim those directories are archived.
