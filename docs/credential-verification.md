# Credential backend verification — 2026-10-24

Repository: `alexj11324/Mikka`, `/workspace/Mikka`, branch `work`.
Base is `5a0e1c411f487fee433c48414f7130d0d58dad92`; verified against
`git ls-remote origin refs/heads/main` before implementation. The requested local delivery commit is recorded in the external
manifest. No push, PR, merge or deployment was performed. Delivery includes a patch
against this baseline.

**Acceptance status: NOT COMPLETE (#180 / MIK79).** The first commit `4bc7258`
was a local candidate. The system-registration increment below is not evidence of
real Infisical, deployed Mikka, frontend or real-account acceptance.

## Executed evidence

- `CREDENTIAL_TEST_ADMIN_DATABASE_URL=<isolated-loopback-/postgres> node scripts/test-credential-backend.mjs`:
  **16 reported tests, 16 pass, 0 fail, 0 skipped**. Final TAP:
  `/workspace/credential-backend-delivery/acceptance.tap`.
- Real HTTP, Better Auth signup/session cookies, two newly created Postgres databases,
  actual advisory locks/CAS/lifecycle triggers, real localhost upstream and Chromium.
  Vault storage and Infisical transport are **synthetic fakes/contracts**, not real
  Infisical acceptance. No real account login or OAuth grant was performed.
- Cross-user/session/workspace/task/run/target refusals; CSRF, size/schema rejection;
  nonce replay; cancel/expire racing put/read; cancellation after use admission; explicit
  session save; workspace suspension/deletion, auth session revocation, device disable,
  run stop/session change; deletion retry and late provider write tombstones; five
  concurrent operations with an application pool of size one; service policy drift.
- Real browser static-form fill/POST, synthetic site's authenticated-cookie/selector
  verification, secret-window DOM/screenshot/click refusals, blocked raw CDP/recording,
  process/profile destruction and blank-context restoration after success/failure/cancel.
  Actual executable removal forces replacement launch failure: the session remains
  quarantined, observers receive 423, and the vault entry is removed.
- Test output contains no synthetic credential marker (runner checks before printing
  or writing TAP). Postgres server log check: **0 marker occurrences**. DB rows/events
  are checked for secret/nonce absence; provider errors and echo response bodies/headers
  are not returned.
- Entire current-main migration chain including the new migration ran successfully on
  two additional fresh disposable Postgres databases. Three credential lifecycle
  triggers verified. Log: `/tmp/mikka-credential-full-migrations.log`.
- Migration naming/order checks: **28 files accepted**; migration policy tests:
  **11 pass**. Existing auth/config/request-scope regression tests: **13 pass**;
  `/tmp/mikka-credential-regressions.tap`.
- `oxlint --deny-warnings` over every new source/test/route/script: **pass**.
- Initial focused typecheck passed. After installing the exact frozen lockfile's
  dependencies, the whole-checkout and daemon-package `tsgo --noEmit` both pass.
  The earlier 23 missing-dependency errors are historical, not current blockers.

## Independent reviews

The initial read-only trace checked AGENTS.md, authentication, application/workspace
databases, run/device/session APIs, migration tooling and the cloud computer handoff.
No Infisical adapter or enforceable shared CUA gateway was present on main.

Independent review `credential_review` identified connection-pool reborrowing, missing
cleanup scheduling/disabled-cleanup behavior, policy drift, and the existing 90-second
lease renewal gap. Fixed: lock-held queries reuse the current client; complete policy
fingerprints; independent cleanup factory and staged cron; database lifecycle revocation.
The existing daemon lease gap was deliberately not patched into this task.

Fresh read-only reviewer `fresh_browser_review` examined all changed source, SQL and
configuration, then rechecked the final deadline and user/workspace existence changes.
It found no exploitable secret disclosure or authorization bypass within the stated
owned-session boundary. Its WebSocket egress candidate was closed by disabling page JS,
blocking Service Workers/WebSockets and keeping the exact URL allowlist. The reviewer
also ran the synthetic Infisical contract test (1 pass), with no services or credentials.

Earlier reviewed one-shot checkpoint SHA-256:
`e4b1ceb0fd52ce85499207d4ca77234bcf130dba52a2d2db1006a8c4ab75ef7b`.
The final read-only increment confirmed user/workspace joins and real POST-window 423
assertions without new findings. This is a scoped engineering/security review, not a
completed Codex Security scanner/SARIF run: the cloud skill's referenced preflight
resource/helper and scan tools were unavailable in this host.

## Integration boundaries and remaining gates

- Default production credential admission is disabled. No production platform telemetry
  or ingress body-capture exclusions have been verified. Parent's current online
  permission metadata confirms an existing project admin identity; the separate authorized
  staging synthetic CRUD below has passed. Historical read-only identity notes do not
  describe that current identity. No IAM was changed.
- Owned Chromium is an optional **dedicated trusted runner** module, tested locally.
  It supports allowlisted static forms, not JS login, arbitrary websites or existing
  shared browsers. A same-task continuation policy now retains authentication for
  declared page navigation, non-form anchor clicks and structured business-region reads.
  Finish/cancel/disconnect/TTL destroys it; there is no cross-task cookie persistence.
  Same-host hostile shell/process access is outside its boundary. Production runner,
  Chromium sandbox, cgroup/watchdog crash cleanup and service isolation are not deployed.
- Cleanup/quarantine holds the fence until destruction and replacement succeed. Deadline
  checks do not guarantee hard-time reclamation if a database query stalls. Forced
  replacement launch and real directory-permission deletion failure/quarantine/retry
  are tested. Host crashes are not dynamically tested.
- Read-only PR #79 inspection: candidate
  `9760e91299bf54165c04a2caafb383f9cc85b13f`, existing `recordDeviceHeartbeat` renewal
  and `{leases}` protocol. Not merged/copied or required by the short local test.
  Main's 90-second run lease remains a fail-closed limit on longer sessions.
- The system increment changes daemon main, run-context and its MCP bridge, preserving
  existing handoff tools. It reuses the existing `RunAssignment.mcp` field; no protocol
  schema, heartbeat, `adapters/claude.ts` or subscription launcher source changes.
- **BYOS combination:** preserve its subscriptions cron while appending this patch's
  credential-cleanup cron. Merge `package.json` and `pnpm-lock.yaml` additions rather
  than replacing either file. Production cron config is staged only; no schedule was
  deployed or paid resource created.
- After specific user authorization, real Infisical synthetic writes/reads/deletes were
  executed only in staging `/credential-acceptance/mik79` (details below). OAuth grants,
  real account login/revocation, IAM changes, SMS/email and publish/deploy were never run.

Frontend/API wiring and the owned-runner integration contract are in
[`credential-backend.md`](credential-backend.md). No product UI or Figma was authored.

## Retained-task continuation increment

The prior one-shot limit was replaced with a same-task, reference-bound continuation
policy. Real Chromium now logs in, destroys the password process/profile while internally
retaining only the selected HttpOnly cookie, restores a password-free authenticated
process, clicks to a second protected project page and returns its business text through
the unified broker. Named navigation back also succeeds. This is a real protected-browser
action, not only a fixed account identifier. The fixture rotates its cookie and echoes it
in a readable region; output is redacted, including across the output truncation boundary.

New acceptance verifies unlogged-in refusal, sensitive-phase action refusal, owner/task
refusal, normal task completion, cancellation, TTL expiry, run completion and real
chmod-based cleanup failure followed by quarantine and successful sweep retry.

Independent retained_session_review found and verified fixes for cleanup ownership retry,
lost replacement handles, cancel/restore races, second-service exclusion, stale tombstones,
truncation/overlap redaction, cookie rotation/path coverage and the account projection.
This increment remains an engineering/manual security review, not a sealed scan.
The earlier owned-executor hash above identifies the earlier one-shot checkpoint only;
current file hashes and local commit are recorded in the delivery manifest.

## System-registration and bounded fallback increment

Current local suite: **18 pass, 0 fail, 0 skip**, including the real HTTP/SQL and
Chromium cases above plus live tool-context derivation, saved API credential finish,
cross-service browser-request exclusion, an injected direct-fill failure followed by
actual keyboard fill/POST while observers remain fenced, and a real readonly password
target entering `handoff_required` without vault read and with complete cleanup.
TAP: `/tmp/mikka-credential-acceptance-KUkMkG/acceptance.tap`.

The actual harness MCP child was spawned from `RunContext.mcpServer()` and exercised
over stdio against a synthetic HTTP backend: **1 pass**. It preserves the three old
handoff tools; discovery makes zero backend requests; the platform token is absent
from child argv/env/output; a transient initialization 503 recovers; wrong-run and
stopped calls refuse without forwarding. This is real transport, not a model-driven
run or proof of SRT proxy isolation. Existing daemon `agents.test.ts`: **17 pass,
7 host/network-gated skips**. Full root and daemon typechecks pass; migration policy
checks accept **30 files**; the full migration chain including browser binding and
handoff ran successfully on two fresh disposable databases.

Fresh independent review found and rechecked fixes for API finish, blocking remote
tool discovery and a permanently rejected initialization promise. Its final fallback
review found no new blocking path within the owned, static-form boundary. No scanner
seal, actual model run, shared-browser safety or generic website-login proof is claimed.

Actual Next entry-point acceptance was attempted again from the current source snapshot:
`/tmp/mikka-system-credential-XKxSzS/next.log`. The process fails loading the repository's
unchanged Next config because SWC rejects both cache and temporary-mode root ancestry
owned by UID 65534. No API route was reached. The dedicated-runner cleanup getter is
independent of browser admission/configuration and sees sessions created after caching.
Next, SRT per-run proxy, deployed telemetry, durable host-crash reclamation and
same-version frontend/real-account acceptance remain unverified. A normal cloud
execution host with trusted cache ancestry or an authorized frozen deployment is needed;
no security-check skip, dependency downgrade, push or deployment was performed.

## Authorized real Infisical synthetic CRUD

User explicitly approved staging `/credential-acceptance/mik79`. This environment's
normal Universal Auth configuration succeeded through its inherited platform proxy;
tokens remained only inside trusted backend probe processes. No admin token was
copied into this thread, CLI argv, repository, model tools or a harness process.

The initial missing test folder produced POST/DELETE 404. Metadata showed no `mik79`
child under `/credential-acceptance`; the dedicated child was created, ID
`8c292056-e9d5-4148-a4c0-c1601ceb7ad2`. It remains as an empty test directory for
subsequent integration; this task did not delete a pre-existing folder.

Four new random synthetic records subsequently each completed **POST 200 → GET 200
with in-process equality check → DELETE 200 → exact-name GET 404**. Final pending
record cleanup count is **0**. Earlier failed-attempt names were also independently
rechecked as DELETE 404 / GET 404. No broad secret list, business value read, IAM,
production or account operation occurred. This is actual Infisical adapter CRUD,
not full Mikka or real-account/provider-login acceptance.

Evidence (no values or tokens):
`/workspace/credential-backend-delivery/real-vault-GdnpQJ/provider-report.json` and
`manifest.json`; earlier exact-name cleanup reports are under `real-vault-Rxx6mj`
and `real-vault-NFe2ZR`. The no-secret, write-ahead recovery driver is
`scripts/accept-credential-vault.mjs`. It is never run by normal tests/startup.
