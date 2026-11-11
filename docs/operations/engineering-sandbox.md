# Engineering acceptance on Cloudflare

Run the `Cloudflare engineering sandbox` Actions workflow on `main` to test a
committed revision in a disposable Container. The caller supplies the Mikka
issue, the exact upstream Git SHA and one of the supported workloads.

```sh
gh workflow run engineering-sandbox.yml --repo alexj11324/Mikka --ref main \
  -f issue=1503 -f workload=factory-handoff -f sha="$SOURCE_SHA"
```

| Workload | What executes on Cloudflare |
| --- | --- |
| `factory-handoff` | The factory handoff regression tests for owned device failover and recovery. |
| `startup-timing` | The startup timing report regression tests for aligning and filtering dispatch, runtime and native CLI timing evidence. |
| `postgres-policy` | Node 24 and pnpm 10.34.3 start a fresh unprivileged PostgreSQL 17 cluster, apply the selected revision’s real CLI-policy migration and verify its triggers and transaction rollback. |

Actions authenticates with its short-lived GitHub OIDC token. The Worker
requires the upstream repository ID, trusted workflow path, main ref and event.
The Worker obtains the declared public source files at the exact commit.
The single-use Container has no GitHub token, Cloudflare token, application
credentials or internet access. It runs the repository test on Node 24. Every
Actions run attempt and workload has a separate Container identity.

At most two runs use compute at once. Each receives a ten-minute hard deadline
and a 30-second inactivity timeout. Completion, failure and cancellation save
the result and explicitly destroy the Container. A Durable Object alarm
releases an orphan at its deadline. On an object restart, the runner stops the interrupted immutable job and records its outcome. A stop failure keeps the capacity slot
reserved and retries cleanup. Duplicate submissions return the existing state.
An active duplicate receives HTTP 409; a full runner receives HTTP 429.

The Actions artifact contains the issue, source revision, owning run, status,
settlement and stop times, bounded test output and available cgroup counters.
The Durable Object expires its receipt after seven days. GitHub retains the
corresponding artifact for seven days. Source remains in Git throughout. This
execution path does not host an editable checkout or create filesystem
snapshots. Cancel the originating Actions run to stop the corresponding job.

The other database suites, browser, privileged Docker and live subscription checks still use their
existing acceptance jobs until each workload has a tested Cloudflare profile.
Those CI and release gates remain required. The account budget includes other services; run and issue identifiers keep engineering usage attributable. [Provider billing and quota evidence](https://github.com/alexj11324/Mikka/issues/1934)

The database profile uses a Cloudflare-managed registry image built from digest-pinned official Node 24 and PostgreSQL 17 images and the checksum-pinned project pnpm version. Its PostgreSQL server listens only on a private Unix socket and exits before the Container stops. It receives no remote database URL.
