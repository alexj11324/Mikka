# Isolated HTTP trace acceptance (#1512)

This is a development-runtime integration check at one fixed Git revision. It
runs the real HTTP API, Postgres, WorkflowAgent and durable steps, source daemon,
repository clone, worktree, verification, commit, push and completion handlers.
It uses the existing isolated MVP subscription/model and GitHub API boundaries.
The real Codex adapter drives a **synthetic app-server protocol peer**, selected
through the daemon's existing test binary override. It makes **zero real model
calls**, creates **no E2B VM**, and is not a
production, Preview, session-replay UI or live-provider acceptance gate.

## Run inside the isolated Docker workspace

Use Node 24, Git and the repository's pinned pnpm version, already installed
locally. Check out the exact intended
commit, install the frozen lockfile, and provision a **fresh, owned** Postgres
database named `mikka_e2e` on loopback. Set `E2E_DATABASE_URL` privately to that
database. The URL needs a password and a role that owns this disposable database.
Do not point this at a pre-existing shared database or reuse a previous failed
environment marker. No production credentials are needed or accepted.
The runner creates its own `gh` shim using the existing
`scripts/dev-local/gh.mjs` loopback transport; a globally installed GitHub CLI or
GitHub login is not required. Host GitHub tokens are refused. Before schema setup
or model work, command/version checks verify Node, Git, the cached pinned pnpm
and that generated synthetic CLI. These checks neither log in nor contact a
service; missing commands stop with fixed prerequisite codes.

```sh
corepack pnpm install --frozen-lockfile
node --test tests/mvp/trace-collector.test.mjs
node tests/mvp/run-trace-chain.mjs
```

The runner uses `scripts/setup-e2e-db.mjs` and the supported local-test bootstrap
CLI, binds the real account pool to the exact revision and DB, generates its own
private authentication secret, and acquires accounts by real HTTP signup/login.
It does not set CI/GitHub Actions identities. It starts the supported
`apps/api/scripts/dev.mjs` development server, which compiles the real Nitro/API
and frontend graph. A production build intentionally refuses to distribute a
loopback tracing endpoint; this check does not weaken that restriction.

Ports: app `localhost:3100`, existing MVP services `127.0.0.1:3191`, local telemetry
collector `127.0.0.1:3196`. Nothing listens on a public interface. A test-only
preload maps PostHog's public ingestion origin to that collector; the existing
MVP transport still refuses every other external fetch. The source daemon's
`MIKKA_DEV_GIT_ORIGIN` points to the scenario's owned temporary bare repository,
using the existing local-test origin guard. The synthetic peer additionally
supplies a fixed rewrite on every Git command, verifies that the repository's
canonical origin is the expected fixture URL, and permits only Git's `file`
protocol. CLI child processes cannot fall through to a real GitHub push. No
global Git config is changed. The real per-run credential helper wraps the
owned synthetic `gh`, so GitHub API requests remain on loopback while the
application's normal run/device/owner authorization still applies.

As in `dev:local`, unauthenticated POST requests warm the lazy MCP and GitHub
credential routes before native execution. They create no task or credential;
the report records only the fixed route label, HTTP status/content type and
duration. This is development-server readiness, not an authenticated MCP check.

## Assertions and retained evidence

Two cases run through the real RPC action `coordinator.sendCoordinatorMessage`:
successful synthetic execution and an intentional synthetic failure. Each carries a new
W3C trace parent and browser-session reference. The check verifies the persisted
run carrier; daemon registration, repo, worktree and adapter stages; workflow and
Postgres spans; the completion HTTP parent's span; trace-linked stage logs; and
the failure's error status. Synthetic AI events must link to an APM span and the
same session. Known private prompt and error sentinels must never appear in the
telemetry transport. The collector decodes actual OTLP protobuf and retains only
an explicit metadata allowlist; its reader is tested against the installed
official OTel serializers.

The source daemon receives a synthetic equivalent of the cloud's public trace
bootstrap before registration. The test therefore checks the public-bootstrap
contract and HTTP propagation, not provisioning of a real official E2B image.
The fixture seeds the current source-bound model order and its owner's synthetic
subscription, then lets the application create the real run binding. The real
native-lease HTTP handler checks the run, device, owner and binding; the private
test worker supplies only synthetic account/context/access values. The daemon's
normal version and model probes call the synthetic peer. Its fixed version and
usage values exercise protocol compatibility and telemetry, never attest an
official CLI or provider. Evidence explicitly records `syntheticCLI: true` and
`realProviderGenerations: 0`; scripted events must not be reported as live Claude,
Codex or Cursor acceptance. Model policy, run authority and real MCP submit are
unchanged. Before MCP submit, the peer commits the real fixture change, pushes
the exact commit to the assigned task branch, creates the fixture PR and checks
its explicitly synthetic CI result. The daemon then verifies its normal
already-pushed commit/PR/CI receipt. Pending publication never counts as
published: the chain independently waits for the pinned execute run's real
publication record.

The final line gives the path of a mode-0600 `trace-chain.json` containing only
metadata, stage names, safe identifiers, numeric telemetry and stated boundaries.
On failure, closed service diagnostics identify the handler, enumerated
error/code and up to three source positions within `tests/mvp/*.mjs`, without
error messages, arguments, URLs or raw stacks. A bounded AI summary counts both
web and daemon generation spans by fixed service, operation and error category,
including when no case completed. Failed runs leave the API alive for one
20-second telemetry drain before shutdown so its existing batch timer can
export already-created events; no model call or business request is retried.
Child stdout/stderr, authentication files, source prompts, responses and raw OTLP
bodies are not copied into that report. Bounded child diagnostics are retained as
mode-0600 files under `private-logs/`; they must never be published or printed
without inspection and redaction. Account leases are quarantined, device
credentials are revoked, and only the runner's own processes are stopped. Private
fixture/workflow directories remain available for authorized inspection.
