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
| `eve-host-build` | Compile the approved public Node 24 Eve host offline, retain the bundle in R2 and exercise the restored host in a fresh, isolated VM. |
| `postgres-policy` | Node 24 and pnpm 10.34.3 start a fresh unprivileged PostgreSQL 17 cluster, apply the selected revision’s real CLI-policy migration and verify its triggers and transaction rollback. |

For self-hosting, set the Worker variables CALLER_REPOSITORY and
CALLER_REPOSITORY_ID to the dispatch workflow's full GitHub repository name and
numeric ID. Set that repository's ENGINEERING_SANDBOX_URL Actions variable to
the HTTPS origin of the deployed Worker. The workflow rejects pull requests
and runs only explicitly dispatched main jobs. Company publishing belongs to
the [private operations entry](https://github.com/alexj11324/mikka-cloud/blob/main/AGENTS.md).

Actions authenticates with its short-lived GitHub OIDC token. The Worker
requires the upstream repository ID, trusted workflow path, main ref and event.
The Worker obtains the declared public source files at the exact commit.
No Container receives a GitHub token, Cloudflare token or application credentials.
The two small regression profiles and PostgreSQL profile also disable internet access. It runs the repository test on Node 24. Every
Actions run attempt and workload has a separate Container identity.

At most two runs use compute at once. The two regression profiles and PostgreSQL profile receive a ten-minute hard deadline
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

## Match a run to provider usage

Use the receipt’s `providerInstanceId` and the interval from `requestedAt` to
`stoppedAt` in Cloudflare account Analytics. These are Unix epoch milliseconds.
The Durable Object-managed Container instance ID matches its Durable Object ID.
Bound the query to the hour surrounding the run to include delayed samples.

Group `containersUsageAdaptiveGroups` by `instanceId` and sum `cpuTimeSec`,
`allocatedMemory` and `allocatedDisk` for the billing estimate. The latter two
are byte-seconds. Under the same instance filter, `containersMetricsAdaptiveGroups`
reports the observed workload peak as `max.memory` and sampled CPU time as
`sum.cpuTimeSec`. A short run can finish between workload samples. The
account’s Analytics Read permission stays with the operator. The job receives
no analytics token. [Cloudflare query examples](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)

### Full Eve host qualification

The optional `eve-host-build` profile compiles the reviewed public source using its existing
`scripts/compile-cloudflare-eve-host.sh` and runs its compiled-host check. Configure
`EVE_BUILD_REVISION` with the full commit, `EVE_BUILD_SOURCE_SHA256` with the verified SHA-256
of that commit’s GitHub source archive, and an R2 binding named `EVE_BUILD_ARTIFACTS`.
Give this binding its own engineering bucket. The request must match the configured revision
before admission. An operator can calculate the archive digest with
`curl -fL "https://codeload.github.com/alexj11324/Mikka/tar.gz/$SOURCE_SHA" | sha256sum`.
Use a shell with `set -o pipefail` so an interrupted download fails the operation.

A standard-3 instance has two vCPUs and 8 GiB of memory. The full job shares one
15-minute deadline across both VMs and occupies one of the existing two engineering slots. The reviewed repository installs its frozen
pnpm dependencies as UID 1000. Compilation runs in a separate Linux network namespace with
no routes and all capabilities dropped. The compiler writes the compressed public host bundle
(at most 512 MiB) to R2 with the expected SHA-256. The Worker checks its size and stops
the compiler. A fresh standard-1 VM starts with internet disabled, verifies the R2 bytes
again, and serves the restored host on private loopback. Its release mismatch and unsigned
workflow callbacks must return 409 and 403 before the second VM stops. The receipt contains the archive key, digest, exact
source and unprivileged host response. The engineering DO removes this run’s archive when
its seven-day receipt retention ends. A cancelled job releases compute through the same
stop path as the other profiles.
