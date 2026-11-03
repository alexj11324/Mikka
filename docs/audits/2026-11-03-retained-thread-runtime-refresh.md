# Refresh the private runtime without replacing the task computer

## Observed requirement

The official Codex subscription task has an open Factory question tied to its actual original native session and retained worktree. Its installed Mikka worker is the previously validated `1691367c6dff1cc36cde72b702bc2c8a7a31c48e`. A normal subsequent release changed the global default worker to `08054c5a95f82f9b2ab9378029c359198345f761`. Existing paused-machine recovery correctly refuses that mismatch, and the stock-instance bootstrap also refuses overwriting an already installed different worker. A server-side fix alone cannot make the old installed runner support native question resumption.

Occurrence 8/10 × impact 8/10: an ordinary deployment can strand an unfinished task that needs a runner correction; recreating its computer would break the required retained-session recovery. The task's original files and native history must survive the runtime correction.

## Bounded maintenance

The existing owner/session/Origin machine-action endpoint accepts an explicit private-runtime refresh for an existing official task computer and terminal origin run. Reuse the provisioning lease and claim lock, check that no run on that device is active, and verify the local device identity and idle journal. Stage the server-configured fixed source and digest before changing the private runtime. Confirm the owned Mikka process stops, switch the private release and receipt, rotate the normal device credential, and require a fresh authenticated heartbeat plus actual process/RPC source evidence before reporting ready. Maintenance leases also exclude adoption by another run. A failed switch may restore the prior private release, but restoration alone never claims readiness.

The official E2B template and installed CLI packages stay intact. Worktrees, native session history and the daemon journal stay in their original home. Release staging and backups live under Mikka's private `/opt/mikka` paths. No user-selected source, new model tool, subscription rebinding, database schema or automatic publication mechanism is added.

## Verification boundary

Local file/process, API ownership/Origin, and isolated PostgreSQL lifecycle regressions cover the maintenance boundaries. The existing production-build CI verifies that both maintenance scripts are present in the machine route's actual Next file trace. After exact-revision CI and normal publication, the original owned test VM must be refreshed through this endpoint and its real process/source receipt checked before the normal owner answers the question. Native execution, independent review/verification and actual UI acceptance still determine completion; an accepted maintenance request or question answer is insufficient.
