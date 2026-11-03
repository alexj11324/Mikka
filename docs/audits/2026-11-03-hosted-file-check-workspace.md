# Hosted independent file checks without a desktop grant

Issue #1116 resumed task `5489a256-b53c-41eb-9cfd-8cc6ff34aa33` on production revision `e9653702adf21e661ce0bf6a6c3c896574101ce8`, deployment `dpl_4cBEaVDKJ4xGk5Z6KT3GMEttMuyo`. Normal smoke-owner API reads confirmed execution passed and review run `2f29f47c-948c-4087-8980-6242772cc209` was blocked with `Repository URL required; dispatch a new thread.` Review had no native session; verification and human acceptance had not run. The current Bot menu still selected `deepseek-flash` and passed the shared CLI preflight.

Occurrence 10 × impact 9 = **90**: every no-remote hosted delivery check follows this path. The claim correctly omits interactive computer authority under its read-only policy (#1113). The daemon nevertheless required that desktop envelope to select its registered hosted workspace, refusing before creating the independent worktree or calling the model. The candidate is a deliverable with public code SHA null; its private snapshot SHA is `ad2428370a4d306b75fa7560da3025916b969cf1`.

The daemon now recognizes read-only Factory review/verify assignments as hosted workspace work. It still requires the matching registered repository, and checks an expected origin when supplied. Ordinary local assignments still require a repository URL. No desktop permission or provider/model selection changes.

The regression consumes the real daemon claim path without MemoryServer's synthetic remote URL, then checks review and verify against the exact candidate commit. Before the fix both checks completed with an error instead of a submitted report. Afterward both independently created worktrees contain the actual marker file at the pinned Git HEAD. The verify case also exercises the expected-origin check and refuses a mismatched origin before any worktree is created. This uses the real daemon and Git with a synthetic model, not a paid-provider acceptance claim.

Validation: 71 daemon run/native-runner tests pass. Daemon typecheck and targeted lint pass. Reference: [Git worktrees](https://git-scm.com/docs/git-worktree) share repository objects while retaining independent working trees and HEADs. Production acceptance remains a separate step after releasing the updated worker templates.

## Disk recovery boundary

The new cloud environment started from a clean older checkout, `c23ff74f`, with only `/workspace/Mikka` registered. The prior `/workspace/Mikka-backend-final` worktree and `/tmp/mikka-production-*` drivers were absent before this continuation created a new worktree. No original user changes were reset or overwritten. A clean new checkout cannot establish that the original offline disk's uncommitted changes were saved; those changes remain unverified and must not be reported as committed.
