# Older operations issue evidence — 2026-10-31

This records what actually ran, separately from release/deployment prerequisites.
No production database, external notification, cloud/IAM resource or repository
setting was changed during these drills.

## #211: two-store recovery

The fixed-code run used commit `f0be6304c298c9c5d9908a8779a2f04337b5eedb`,
a clean tracked tree, Linux and the existing PostgreSQL 17 container exposed
only at `127.0.0.1:55599`. Its exact tool-source SHA-256 was
`da9022a4f2b31691d842799fafa9a650995ec86256f5c6efe46d2e4a85169b83`.
The existing migration runner applied full Mikka schemas in two new databases.
All source and restored databases and the private evidence were retained:

- `mikka_ops_main_4bcff43c_e2e`
- `mikka_ops_workspace_4bcff43c_e2e`
- `mikka_ops_restored_main_4bcff43c_e2e`
- `mikka_ops_restored_workspace_4bcff43c_e2e`
- Evidence directory `/tmp/mikka-ops-drill-RHPg1b`; authoritative private report `report.json`.

Predeclared local limits were RPO 60 seconds and restore-command RTO 120
seconds. Backup capture was `2026-10-31T02:11:24.053Z`; simulated failure
`02:11:25.535Z`; observed backup age **1,482 ms**. Restore completed at
`02:11:29.288Z`, taking **3,377 ms**. These measure this tiny quiesced fixture,
not production RPO, cross-region recovery or total incident recovery.

Both native database dumps restored with every public table's row count and
canonical-row hash equal to the backup before safety transformations. Both
object payload hashes matched. A post-backup task change was absent as
expected. Current completed deletion replay removed the deleted account,
its solo workspace and its old object, while another account's workspace
membership and run/task data remained. The previously revoked daemon token
stayed revoked, the pending approval became declined, and an executing
external operation became uncertain. No operation/provider action was retried.

Eight negative cases were rejected: wrong independent manifest digest,
migration mismatch, unavailable vault adapter, stale current deletion journal,
corrupt object bundle, missing object bundle, pending deletion journal and an
already existing restore database. Restores stayed quarantined and no
application/worker connected to them. The current deletion manifest's protected
independent digest was supplied outside the old backup. The vault probe was a
controlled local adapter, not a production provider probe. The ephemeral test
encryption key was zeroed; the retained encrypted bundle is evidence, not a
reusable production backup.

Remaining operational dependencies: an actual protected key store, backup
schedule/retention, provider-specific object versions, actual KMS access,
current revocation/deletion journal, and a controlled authenticated application
recovery acceptance before exposure. This run used SQL business fixtures and
the real durable deletion code; it does not claim full application acceptance.

## #212: collection, incidents and alert delivery

The same fixed run queried actual stale wake, expired run lease, unstarted
dispatch and stale executing-effect records. A separate loopback connection
failure produced a database-unavailable alert. A real internal HTTP receiver
accepted four firing signals and five recovery signals. Repeated firing was
deduplicated; a 503 from the receiver was visible and retried successfully.
No external message was sent. Observed first delivery was about 17 ms after
collection in this local run; there was no human acknowledgment claim.

The request-log source tests prove paired invocation timestamps, privacy,
4xx/5xx/error behavior and sink failure tolerance. Monitor tests include 429,
missing completion and timeout in the denominator; the injected 429 here is a
controlled request metric, not a live provider-rate-limit test.

The follow-up `e000162d` adds `GET /api/cron/ops-monitor`, using the existing
CRON_SECRET and main pool, and the additive observation table. Actual route
calls returned 503 without configuration, 401 for a missing bearer and 200 with
an authorized bearer while no notification sink was configured. The last case
returned `persisted: true` and `notificationStatus: not_configured` and wrote a
real database observation. A real PostgreSQL integration test separately
verified persistence, receiver 503/retry, incident deduplication independent
of delivery status and single recovery, passing without a skip. Root TypeScript
checking and changed-file lint passed.

Remaining dependencies: the existing minute worker must include this route;
notification forwarding/acknowledgment needs an existing approved channel and
owner. API SLI requires complete runtime log input. Actual login/chat/run/due/
provider action/report/cleanup end-to-end fault acceptance and a human response
record are not established by these focused component drills. The collector
works without a notification sink; lack of external paging does not prevent
collection or durable incident records.

## #214: supply-chain and release controls

`5d381f16` patches the direct Next runtime from 16.1.6 to the official
16.4.1 release. A separate manifest-only workspace resolution and frozen-lock
check passed, with no shared node_modules mutation. Its audit has zero Next,
Sharp and PostCSS advisories; other workspace advisories remain. No app runtime
compatibility/build claim is made until the new locked graph is installed and
accepted in Linux/CI.

`7ee31914` adds exact-main-commit CI requirements and artifact/SBOM/source-lock/
build-run binding to the existing publishers, preserving their automatic main
release identity. It pins existing Actions to verified upstream tag commit
SHAs. Six source tests exercise real temporary artifact files, tampering,
missing/failed checks, wrong source/build/lock, known high findings, expired
exceptions and intended desktop publication. They passed. npm shrinkwrap and
CycloneDX generation were also checked against a real registry graph.
GitHub's private vulnerability-reporting API returned `enabled: true` on this
date; the real private reporting link is in the vulnerability runbook.

A real daemon candidate was built at fixed source `f0be6304` into
`packages/daemon/.retained-build-gEyUIE`. Pinning its direct installed versions,
resolving npm shrinkwrap, generating its actual SBOM and auditing produced
**two high findings, zero critical**, via sandbox-runtime 0.0.80 → zod 3.25.76.
The release policy returned **allowed: false** and prevented promotion, without
any exception. Evidence: `/tmp/mikka-ops-release-drill-audit.json`,
`/tmp/mikka-ops-release-drill-policy.json`, and the retained candidate. Its lock
SHA-256 is `e448d694ad61a89e62d1c290898599c4871db61d17d10f944da0ca7d5b00cd3f`.

The official advisory is GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404. Current upstream
sandbox-runtime 0.0.81 still declares zod ^3.25.0; zod 3's latest published
version is 3.25.76. Sandbox uses `zod/v3`; simply forcing the package to zod
4.6.7 does **not** prove remediation: its v3 subpath still produced 11 issues
for ten invalid array elements with max(1). No audit-only upgrade or blanket
exemption was applied. A reviewed input-bound mitigation or real upstream/
backport fix remains necessary for a clean publishable daemon graph.

Remaining evidence: new associated hosted CI runs, compatible installed Next
runtime acceptance, a cleaned actual publish graph, signed desktop build and
real isolated successful promotion/rollback. No local/source test is described
as a successful hosted CI, npm publish, signed macOS release or production
rollback. Closing decisions should use the actual issue acceptance and these
explicit limits.
