# Production readiness after merging #1290

PR #1290 was squash-merged as `c07c1db11effa078da7ed70a4c371d41feda84e5`.
Its exact PR head had 18 successful checks and five conditional skips. The
merged application has 15 successful checks and four conditional skips.

## Release and real production run

[Web deploy 41934692696](https://github.com/alexj11324/Mikka/actions/runs/41934692696)
succeeded, including the prebuilt upload and public-version verification. An
independent unauthenticated public GET at **2026-11-04 23:39:36.751 UTC** returned
HTTP 200 and exactly the merge SHA. Only then was the existing trusted
acceptance ref advanced, without force, to the reviewed readonly driver
`2e8c641f2ebcc2a3ff527786f18e2b2bcb10dde5`.

[Production owner readiness 41935491849](https://github.com/alexj11324/Mikka/actions/runs/41935491849)
ran from its application attestation at 23:40:16.686 UTC through completion at
23:40:31.279 UTC. Its guards passed. Readiness returned **partial/failure**, as
required when sources are missing. The original artifact reports are unchanged.

## What was observed

- Normal BetterAuth sign-in/session validation/sign-out worked. The account's
  Owner `cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3` is different from the frozen original
  Claude Factory Owner `XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ`.
- The account's model order was empty. All three independently checked paths
  returned `source_missing`: API `deepseek-flash`, official Claude subscription
  `claude-haiku-5-5`, and official Codex subscription `gpt-6-luna`.
- The full preference fingerprint was unchanged. Task creation, preference
  mutation requests and model calls were all zero. The authenticated session
  was closed. Existing backend maintenance during GET was not measured.
- All three required prospective actions were found in published assets;
  discovery invoked none of them.
- The returned current-workspace/Owner snapshot had 14 Bots, zero unfinished
  Bot runs, six own threads and zero active own threads. It does not establish
  global idleness or reserve any runtime lease.
- The same-app official runtime run 41934692733 skipped publication. The result
  correctly retained `not_published/publish_skipped` and null worker/source
  hashes. It says nothing about whether an older compatible runtime works.

The diagnostic itself is deployed and has exercised its normal production
route. The original CC case and three execution paths are still blocked; this
run is not paid execution, Owner acceptance or a one-hour performance result.
It does not establish that the original Owner's subscriptions are unavailable.

## Integrity and scope

Artifact 13374455631 is 1590 bytes. SHA-256:
`a55ac2bc293411d98dd5878df849abe7c06ba4281e1e0e2af83d8a46e0f57042`.
The ZIP hash was checked before extracting its two allowlisted JSON members.
No credentials, cookies, subscription grants or full preferences are in these
reports. The driver tree differs from the merged main tree only in its exact
application-SHA plan. All 23 workflow-directory blobs (22 YAML files and one
README) match the pre-reviewed tree; the historical paid comparison workflow
is absent. No paid comparison was repeated.

Premerge raw evidence remains at
https://github.com/alexj11324/Mikka/tree/6cb2c761315be201fad78d136a02d7f6ade1a4fa/docs/acceptance/2026-11-04-issue-1210/production-readiness-41933751824 .

#1210, #1211 and #1212 remain open. Continuing the original cases requires their
actual Owner's normal authenticated entry and the prescribed available model
sources; quota or authentication must not be bypassed by switching models,
copying grants, assigning a different Owner or manufacturing a session.

