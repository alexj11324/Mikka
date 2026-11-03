# Exact native session resume for subscription question answers

The live Codex task asked a reasonable `baseline_mismatch` question after its
file had already reached the newer 85-byte target. Answering that question
requires the original native conversation; starting a new session is not an
acceptable substitute. Source review found three Mikka blockers: hosted
adapter capability said `supportsResume: false`, the supervisor rejected any
subscription binding when exact resume was required, and the hosted runner
rejected `continueSession` unconditionally.

Occurrence 10/10 × impact 8/10: every correctly bound official-subscription
question answer takes these unconditional guards and cannot resume. The live
question is a concrete required path, not a speculative new feature.

## Official behavior

[Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
documents `resume: sessionId` for a specific conversation. `continue` chooses
the latest session, and fork creates a new conversation. Sessions preserve
conversation history, not the worktree; both must remain available.

[Codex app-server](https://developers.openai.com/codex/app-server) documents
`thread/resume` with the stored thread ID followed by `turn/start` on that
thread. A fork/new thread does not satisfy exact-session continuation. This
change uses the existing adapter's resume protocol, without adding new
version-dependent API fields or changing authentication.

## Minimal repair

The hosted runner receives the existing daemon journal. A required question
answer joins its original SID and real worktree to the original journal's
harness, model, device, issue/repository and owner/workspace/consumer/binding.
The earlier native ledger must also match the live subscription account,
revision, model and route. This works with existing ledgers that contain no
worktree field: the worktree is checked against the actual retained journal,
not inferred or backfilled into a historical receipt.

Only after those checks does the existing adapter copy its allowed native
history entries and resume the exact original session. The returned SID must
match. The supervisor records `starting` before external answer delivery;
an interrupted uncertain delivery fails closed, and a repeated direct
continuation cannot replay an already-created current-run ledger. Explicit
API-key required-question resume remains refused by the hosted path. Missing
history, a changed identity, another worktree, a CLI refusal or a different
native SID cannot fall back to a new conversation.

The private worker upgrade must retain `worker/runs.json`, the complete
`worker/adapters/runs/` and `worker/adapters/native-ledgers/`, and the original
worktree at its exact path. No official template or CLI package is changed.
The normal daemon constructor supplies its existing journal; no new cloud
upgrade hook, credential migration or alternate account is introduced.

## Verification boundary

The red regression failed for both hosted harnesses on the prior unconditional
continuation refusal. The new offline tests use the real native adapters and
installed Claude Agent SDK with local synthetic CLI protocol processes, real
Git worktrees and persisted native history. They cover original-session
history plus exactly one owner answer, the daemon/supervisor/host path,
source identity/account/revision/worktree drift, missing history, a CLI
returning another SID and repeated-delivery refusal. These are protocol and
regression tests, not paid-provider or production question acceptance.

The actual owner answer through the upgraded preserved question VM remains
required before claiming the live task is repaired.
