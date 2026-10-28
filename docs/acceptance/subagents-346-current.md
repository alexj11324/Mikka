# PR 346 current acceptance checkpoint

This candidate connects the web run's server-owned policy to the existing
pending-actions ledger. Ordinary mutations and navigation use one exact,
canonical receipt: allow executes directly, ask uses its existing decision,
and deny, STOP, expiry, changed policy and replay prevent execution. Direct
mutation through the observation helper is rejected. The additive run-policy
column leaves existing runs null and fails closed rather than inventing policy.

The credential consumer now invokes the existing credential lease and broker
service. Its signed gateway capability includes the observed node and document.
The broker durably consumes the same persisted host action, then verifies the
current policy, run, owner, active machine, target and input before opening a secret. It owns
the policy-to-credentials lock order; the app does not hold that lock across the
service request. Native replacement of prefilled text is restricted to the
observed, focused node. No secret is supplied to the model.

Dependencies in this isolated combination are PR 345 head 0c259ef plus the
source-author-delivered 52743739/6eee5ad4 patches, and computer-policy candidate
88881a352a08c8d34665839f8eaa6cdceba94cf3. These dependencies are not claimed to
have merged. The standalone PR branch has not been overwritten with this entire
combined dependency tree.

## Executed checks

All of the following ran in the cloud Linux workspace, using synthetic data.

- 52 focused Node tests passed without skips: authority/receipt, approval
  dispatch, credential consumer and broker, workflow, visual-message and
  process-version regressions.
- Ten guard tests and three STOP/revocation tests passed. The guard tests
  include real Chromium iframe and open/closed shadow-root snapshots.
- The real PostgreSQL backend regression passed in a new retained schema,
  including repeated additive migration, owner isolation, policy locking and
  separate thread claims.
- The actual gateway WebSocket and Chromium regression passed. Its service
  subprocess exercised real PostgreSQL, AES-GCM, CredentialStore,
  fillCredential and Cdp.insertAtObservedInput. A second fixture filled two explicitly selected nodes, submitted the selected native form, sealed the resulting session and released the actual gateway guard. The fixture supplies the choices; no real model inference is claimed here. Replay, pending approval,
  stale policy, STOP, read-only, invalid policy and a replaced machine were rejected before decryption. KMS was synthetic.
- The durable ledger DB regression passed in a retained schema. Six DB-runner inventory tests passed after enrolling that regression and the dedicated Python/Chromium service harness.
- Typecheck, focused oxlint, 72-file migration validation, standalone broker
  bundling and native Node imports passed.

Resource preservation: the existing pr346-ledger-retained-20261028 container
remains running. New fixture schemas and Chromium profile directories were
retained. Only Chromium processes created by the new test invocations were
closed at their own test completion; no historical process or resource was
removed. The final passing gateway fixture retained
/tmp/pr346-broker-10hug0k6 and schema
broker_dfd7e89ed7ef4b23b8ab1af5b4540285. The backend schema was
subagent_de72684f178f47f883d1d74680ff854b. Earlier failing fixture schemas and
profiles were also retained. Logs are in /workspace/pr346-*-current.log and
/workspace/pr346-final-*.log.

## Acceptance still missing

These checks do not establish final feature acceptance. The configured visual
model has not actually received an image and produced an executed action on
this candidate. There is no new immutable cloud Preview for this source and no
final-SHA remote CI result. Real OIDC/KMS acceptance has not been repeated.
No real account password, cookie or production login was used.

The model may choose up to two observed input roles and one observed submit control before filling. That entire operation is bound to one existing permission receipt; the program does not choose fields or infer which button means login. Native submission and encrypted session capture have passed the local real-gateway/DB fixture. A single-field choice without a submit control still returns guarded and retains viewer exclusion. Submitted and session_applied are mechanical results that require another model observation, not evidence of successful login. Freshly captured session reuse on an actual provider remains unverified.

The currently selected Vercel connection cannot access the required team.
GET project mikka in scope mikka-dev returned 403. The supported team-consent
operation returned 404 for both the API-reported team ID and its slug. A
read-only membership listing on that same connection contains only
alexs-projects-078b8b0b, not the Mikka team. No alternate identity, token or route
was used to evade that denial. The connection must be authorized for the Mikka
team before immutable-Preview and real-provider acceptance can proceed.

PR 346 remains unmerged. Neither old green checks nor synthetic KMS is used as
an exemption from the final real-function acceptance gate.

## Cloud CI

Candidate branch: candidate/pr346-acceptance. Source 8acd5b54b1c0e4704ec709a44b5e7ffc3bce5d31 passed backend CI 40784881561. Full CI 40784881672 exposed missing ledger-suite enrollment, corrected in the next candidate. Browser workflow 40784948862 was allowed to finish independently; it does not attest to later source changes. No PR was merged. The Vercel Git configuration disables non-main previews; it has not been silently changed while the intended team connection is unresolved.

The live AI Gateway catalog was read without inference. The existing free Coordinator model reports text-only input. openai/gpt-6.1-sol reports image input and tools, with base input/output rates of US$2/US$10 per million tokens. A maximum three-request, Standard/High functional probe with a US$0.15 ceiling was requested separately; no paid request has run. No benchmark or live-eval was enabled.
