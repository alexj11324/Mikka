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

Use Node 24 and the repository's pinned pnpm version. Check out the exact intended
commit, install the frozen lockfile, and provision a **fresh, owned** Postgres
database named `mikka_e2e` on loopback. Set `E2E_DATABASE_URL` privately to that
database. The URL needs a password and a role that owns this disposable database.
Do not point this at a pre-existing shared database or reuse a previous failed
environment marker. No production credentials are needed or accepted.

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
MVP transport still refuses every other external fetch. Git uses a child-local
rewrite to the fixture's real bare repository. No global Git config is changed.

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
unchanged.

The final line gives the path of a mode-0600 `trace-chain.json` containing only
metadata, stage names, safe identifiers, numeric telemetry and stated boundaries.
Child stdout/stderr, authentication files, source prompts, responses and raw OTLP
bodies are not copied into that report. Bounded child diagnostics are retained as
mode-0600 files under `private-logs/`; they must never be published or printed
without inspection and redaction. Account leases are quarantined, device
credentials are revoked, and only the runner's own processes are stopped. Private
fixture/workflow directories remain available for authorized inspection.
