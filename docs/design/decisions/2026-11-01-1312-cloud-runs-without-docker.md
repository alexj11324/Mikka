# Cloud runs use no Docker: one task, one machine is the isolation

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session after cloud runs failed
  because `docker create` of the 1.1 GB hosted image took 65.7 s on a thread
  machine started from a snapshot (vfs storage driver, cold disk) and the
  worker gave it 30 s. Alex: 「肯定不会冲突，我明确说过一个任务一台机器。加 Docker 本来就是过度设计。」
- Rule: —
- Superseded by: [2026-11-01-2335 E2B official templates](2026-11-01-2335-e2b-official-templates.md) for the sandbox-runtime part and the device paragraph; one task, one machine stays
- Replaces: the Docker container per hosted run (network none, read-only root)
  in [unattended-sandbox.md](../unattended-sandbox.md) and the 「Mikka Cloud
  (E2B)」 column of the runner table in [orchestration.md](../orchestration.md)

A cloud run happens on its task's own E2B machine, and that machine is the
isolation boundary between tasks: no other task ever runs on it. The cloud
worker no longer creates a Docker container per run.

Inside the machine, Anthropic's sandbox-runtime (bubblewrap) encloses the
CLI's bootstrap, the CLI and everything they start, in their own process
group that a stop or revocation ends as a whole. This sandbox is the security
boundary between the agent and the worker, not an extra layer: it is what
keeps the worker's device credential, RPC secret, journal and logs, the owner
session ledgers and the model key (held by the broker in the worker process)
out of the agent's reach. It has no network of its own; the run's broker and
public-egress relay sockets are its only ways out, so Linux's unix-socket
blocking is turned off for it (`allowAllUnixSockets`, which the
sandbox-runtime README documents as "Disable seccomp blocking") and every
other socket a run could see is hidden with `denyRead`.

The CLI's own sandbox is off inside it: the sandbox-runtime README says a
sandboxed command "may not create" a user namespace, so "a nested bubblewrap
or srt" fails ("The command stays in the namespaces made for it"). The outer
sandbox confines every command instead.

What stays as it was:

- Provider custody: the CLI gets a placeholder and reaches the model only
  through the run's broker on the worker; no subscription token or API key is
  in its environment or files.
- The run's public-egress relay, run home, GitHub runtime and the host-secret
  environment guard.
- A verify command runs in sandbox-runtime with no network and the worktree's
  `.git` read-only.

~~Devices are unchanged: a person's computer or server still isolates a run in a
container where Docker exists, otherwise in the daemon's own sandbox.~~
Superseded by [2335](2026-11-01-2335-e2b-official-templates.md): a person's
computer or server runs the CLI directly, with no container and no sandbox.

How it is built: `packages/daemon/src/subscription-hosted-runner.ts` wraps
`agents/native-container.mjs` in sandbox-runtime and hands it the host paths
of the CLI, the broker and egress sockets and node; the E2B template installs
bubblewrap, socat and ripgrep (`scripts/e2b/bootstrap.sh`). It takes effect
once the template is rebuilt and republished with the new worker.
