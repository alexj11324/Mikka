# Live rollout follow-up: private workspace and concurrent releases

Tracks #1131, #1132 and #1136. Full two-subscription acceptance is still pending.

## Fresh official task instance

The first normal official-Claude request created issue
d127083b-3650-4af8-85a5-2693981a230b / Factory task
bb5fc90c-8ec4-47c7-8b07-20a6b397090c. Execution
5760fef1-3ebe-4523-8415-6fd71c532b2d failed with
`Cannot use simple-git on a directory that does not exist`, before a native
Agent session was created. Retry 8fbd3223-f38e-4add-8ed5-f87d467b797a was
cancelled, also without a native session. This is not a passed Claude Agent run.

The Bot's registered private Git workspace had been initialized on its parent
computer. A fresh official task instance intentionally inherits no parent files,
so it lacked that directory. Share the parent initializer with new official
task provisioning, after the stop check and before worker credential handoff.
It initializes only the exact registered UUID-derived Bot workspace beneath
`/home/user/.mikka/bot-workspaces`; existing instances and other paths keep their
existing behavior. No official template files are changed.

A real PostgreSQL/fake-E2B-boundary regression reproduces the same simple-git
failure before this fix. Afterward the actual shell initializer and Git worktree
creation succeed. A second initialization preserves existing uncommitted bytes
and the original commit. Parent/device movement and stop/adoption/lifecycle
checks remain enabled: 25 relevant database tests pass locally, alongside
application typecheck and root lint.

## Concurrent production publication

While c18554a7 validated its official instances, newer main b0553336 became
READY. The old exact-source search skipped that application and redeployed
older c18554a7 as dpl_9uHfM4bg31JfK6UsN8xXoLAwToXp. Cancellation arrived after
READY and was refused. We requested b0553336 again with the new official runtime
configuration, producing READY dpl_4AWmULjS5cQmZ4kUyB8wxoGcYaSX.

The queued official-runtime release 41663962019 then completed for b0553336,
with READY dpl_7pNks5bszTdBQmkY4WH4NgDmPStF, worker source b0553336 and digest
453cf228b1ce577b55323a2586893e8632a337f6. This was a source/worker configuration
change from c18554a7 / aa81fc95; it cannot be treated as an equivalent rebuild.
The version fence stopped the Codex request before submission. The first
Claude attempt above is retained as diagnostic evidence, not fixed-version
acceptance.

Publication now requires the latest READY application's source to match, and
refuses before any configuration write or redeploy when it moved. The
newer-READY/older-matching regression fails before the correction; all eleven
publisher tests pass afterward. The historical template workflow stays
disabled. No API-key/DeepSeek fallback or protected-Acme operation occurred.
