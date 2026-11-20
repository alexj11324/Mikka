# Mikka acceptance adapter

Follow [PROCESS.md](PROCESS.md) for the runner/checker handoffs. This file maps
that process to Mikka's actual entry points. Commands below run from the public
repository root in an isolated cloud Linux checkout. Record its full Git SHA;
an official UI run also records the private overlay SHA.

## Start the local application

Use the repository-pinned Node and pnpm, installed dependencies, and local
PostgreSQL 17. Supply `E2E_DATABASE_URL` through the process environment; every
configured database URL must identify the same disposable loopback `*_e2e`
database. Do not copy a production URL into this environment or create a Neon
branch. The local guard refuses deployment environments and other DB targets.

```sh
export MIKKA_LOCAL_TEST_ACCOUNTS=1
export MIKKA_DEV_SKIP_ENV_FILES=1
corepack pnpm dev:local
```

`scripts/dev-local.mjs` starts the API/Vite application, fake service HTTP
server on loopback port 3191, and the real daemon. The default app is
`http://localhost:3000/mikka`; `MIKKA_DEV_PORT` selects a separate owned port.
When the runner is root, provide `MIKKA_DEV_DAEMON_USER` as an existing
unprivileged Linux user for the daemon. Do not use `CI=true` to bypass the
local guard. Stop the owned parent process to clean up its children.

The scripted default does not need a model key. It replaces inherited model
credentials and LiteLLM origin with loopback fixture values. Acceptance never
enables live-model mode. Native subscription or provider account availability
does not substitute for scripted evidence and is not a reason to call a model.

For automatic API/CLI acceptance, the existing runner starts and stops its own
environment, leases accounts, and runs the selected items:

```sh
corepack pnpm test:local-loop
LOCAL_LOOP_ITEMS=1,2,3,4,5,6,7 corepack pnpm test:local-loop
```

Choose the affected item set in the accepted plan. Preserve the resulting
`.cache/dev-local/acceptance-*/environment-summary.json`, `source-evidence.json`,
and `passed-items.json` privately until sanitized evidence is published. Read
the selected item IDs, completed item IDs, fixed-source fingerprint, source
revision, runtime IDs, and final exit status. The summary must show actual
passed/total counts; a startup line does not establish a passing loop.

## Fixture UI and screenshots

The fixture entry point builds the application with `--local-fixture`, applies
the repository migrations to the isolated DB, seeds a named scene, and starts
the guarded loopback fixture app. The screenshot entry point owns the same
setup and captures deterministic output twice for comparison:

```sh
node scripts/fixture.mjs board
corepack pnpm screenshots board
corepack pnpm screenshots all
```

Scenes are `empty`, `board`, `task`, `automations`, `bot-settings`, and `pulls`.
The automation scene also captures its editor. Output belongs under
`.cache/screenshots/<default|official>/`, with a PNG per scene and a
`manifest.json` that identifies the source, scene, build variant, and comparison.

For the official appearance, use a separately checked-out private
`alexj11324/mikka-hosted-ui` overlay and supply its directory through
`MIKKA_UI_OVERLAY_DIR`, with its exact revision recorded. Run the same scene
set for both variants. Keep private source in that private checkout; screenshots
and a source revision are sufficient public evidence. A default public-only
fixture proves its own behavior and compilation; it does not prove that the
official paid slot still matches the public props. Review the official capture
before accepting a visual change.

Some public default slots deliberately reject unsupported rendering. A scene
that reaches such a guard is blocked for that build variant; preserve the real
error. A blank/error page or two identical error captures are not screenshot
acceptance. Record the official overlay result separately, and leave an
unsupported default scene unverified until its actual renderer is implemented.

Fixture auth stays in the dedicated loopback proxy and uses real BetterAuth
sessions. Do not turn fixture headers into a production auth shortcut. Freeze
only fixture-owned data/time/IDs; keep the changed renderer and route owners real.

## External boundaries

| Dependency | Fixture entry point | What remains real |
| --- | --- | --- |
| Models | `tests/fakes/litellm.mjs`: `startFakeLiteLlm` / `createLiteLlmRoutes`; `/litellm/v1/chat/completions`, `/messages`, `/responses`, `/decisions`, `/models` | Application LiteLLM request construction, parsing, tool calls, persistence, and UI projection |
| E2B | `tests/fakes/external-services.mjs`: `startExternalServices` / `externalServiceRoutes`; SDK `apiUrl` and `sandboxUrl` point to loopback `/e2b/api` and `/e2b/envd` | Official E2B SDK serialization and the application's E2B owner code |
| Slack | The same HTTP fixture, `/slack/api/*` | Official Slack SDK, response/error handling, and notice owner |
| GitHub | `tests/fakes/github.mjs`, composed through `tests/mvp/services.mjs` | Official Octokit request path and real local bare Git clone/worktree/commit/push |

Model substitutions belong only at LiteLLM. Keep hand-authored scripted cases
distinct from recordings. A replay case needs sanitized provenance, protocol
messages, its expected outcome, and a stable name; inventing a response is not
recording a session. A fake controls the provider response, not the durable
application observation required by the check.

Useful boundary checks are:

```sh
node --test tests/fakes/litellm.test.mjs tests/fakes/e2b.test.mjs
node --experimental-test-module-mocks --import ./scripts/server-test.mjs --import tsx --test lib/slack/automation-notice.test.ts lib/coding-workspace/machine-metrics.test.ts
```

These prove the named contracts. They do not by themselves prove an entire
device or E2B user workflow. Select the applicable application-level checks
and readbacks below before declaring a runtime accepted.

## Accounts and ownership

`scripts/test-accounts/pool.mjs` owns isolated account pairs, generation-bound
leases, cleanup manifests, and quarantine. `session.mjs` supplies authenticated
owner/peer transports; `bootstrap.mjs` verifies environment identity. Prefer
`withTestAccounts` for a new scoped check so release runs in `finally`.
The local-loop runner already uses these supported owners; do not register
unrelated accounts or craft cookies beside it. The UI fixture is a separate
disposable-data case: it owns fixed, namespaced identities in its guarded
loopback database and signs in through real BetterAuth. That identity proves
fixture rendering, not an account-pool lease or ordinary runtime acceptance.

Use the CLI for metadata inspection after the environment is initialized:

```sh
corepack pnpm test:accounts inspect
corepack pnpm test:accounts cleanup-plan --run <run-id>
corepack pnpm test:accounts audit-evidence --evidence <sanitized-artifact-path>
```

Record environment/run/lease IDs and account aliases in evidence, never lease
files, login state, tokens, or DB credentials. A cleanup uncertainty quarantines
the pair. Never repair an acceptance run by deleting a production user,
revoking a shared credential, or cleaning resources without ownership proof.
See [test accounts](../../docs/test-accounts.md) for the existing environment
and account APIs.

## Probes and distinct runtime proof

| Scope | Probe or execution | Required observation |
| --- | --- | --- |
| Device | Local-loop with the real daemon and scripted LiteLLM | Device/run IDs, daemon claim and terminal state, persisted chunks/messages, expected tool or artifact, and a readback from the owning API/DB; repository changes also require the bare-origin commit and publication projection |
| E2B | Select the application's E2B path with the official SDK directed at the HTTP fake | E2B path selected rather than device fallback; create/connect/process response, real application run/session persistence, resulting chunks or artifact, cancellation/failure readback when affected |
| Readiness | `GET /api/version`; local `POST http://127.0.0.1:3191/refresh` after account/Bot creation; `/observations` on that fixture | Serving source/version, completed setup, or recorded fake API calls; these are setup/protocol probes, not completed execution |
| PR admission | `node scripts/ci/pr-acceptance-github.mjs --repo alexj11324/Mikka --pr <number>` | Current PR head, declared mode, deterministic errors; a publish rehearsal separately reads back the GitHub status and label |

The E2B SDK fixture test alone is a protocol test. Label a full E2B runtime
check `uncertain` until the application's selected E2B owner and persisted
result have been observed. Likewise, daemon registration alone is not a device
execution. A successful device run cannot cover the E2B row or vice versa.

For metadata-writing PR rehearsals, `--publish` uses `GITHUB_TOKEN` from the
process environment. It never accepts the token in argv. Preserve and restore
the PR body, exercise missing evidence followed by a corrected declaration,
and read the `PR acceptance` status plus `acceptance:missing` label back from
GitHub for the exact head. A loopback GitHub fixture is separate test evidence.

Only OAuth, app installation, payment, and push checks that require their real
external integration may use the issue's `Production only` exception. Assign
an owner and internal account alias, use the internal-first process, and record
the actual serving source. No real model request is part of that exception.
