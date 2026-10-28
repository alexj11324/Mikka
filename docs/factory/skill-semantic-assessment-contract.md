# Skill comparison semantic assessment increment

This source increment is based on the existing #316 registration, frozen case
assignments and mount receipts. It adds no scheduler, publication path or Skill
registry. Model benchmark/live evaluation remains explicitly OFF in server.ts.

## Minimal interfaces and file boundaries

- `comparison-collector.ts`: read-only `loadComparison({userId, issueId,
  proposalId, evaluationId})` reads existing Skill case/arm/run/session/mount/
  version/settings rows and actual artifact_versions/storage. Missing, stale or
  ambiguous provenance returns null. Raw mounted SHA256, source commit, candidate
  commit and proposal document digests are distinct values. Markdown/HTML is
  text evidence; linked images are not fetched or claimed as visual acceptance.
- `registered-evaluation.ts` and `semantic-assessment.ts`: dependency-injected
  existing #331 invokeDecision transport returns structured improved /
  not_improved / regressed / unknown plus a host request/response receipt. The
  scorer definition/version is fixed by code, outside candidate Skill content.
  Provider receipts and pixels do not prove semantic understanding or permission.
- `evaluation-comparison.ts` and `evaluations.ts`: short mechanical snapshot
  transaction, release, collector/model await, then short revalidation/commit
  transaction. Pending/unknown does not consume the immutable final-result slot.
  First assessed result is immutable and replayed. SQL mechanical-snapshot and
  collector full-snapshot evidence digests are stored separately.
- `activation.ts`: existing #193/#194 evidence/approval/activation route consumes
  a prior model-assessed result and rechecks current lineage without initiating
  provider or storage work while holding publication locks. Existing human
  approval/verification/revocation boundaries are preserved. There is no automatic
  candidate adoption and no new mandatory approval fallback.
- `regression.ts`: the historical synthetic document fixture now returns unknown;
  keyword presence, negation or quoted instructions cannot assert improvement.

An assessment never grants authority. Current owner, issue access, enabled device,
Factory candidate/terminal fences, exact session/mount/version/settings, immutable
run evidence and current approval checks remain mechanical requirements. Feedback
and generated reports/documents are untrusted observations, not truth or commands.
Candidate code cannot alter criteria, permissions, model budgets or thresholds.

## History and integration dependencies

Historical CPU results remain untouched and cannot be relabeled or accepted as a
model assessment. Their existing immutable result slots require an explicitly
versioned future assessment lineage before reevaluation; this patch performs no
ledger rewrite, delete, or production SQL. It does not manufacture old mounts.

The isolated projection includes the exact parent-supplied #331 decision source
and main dd6d8d4 artifact storage source/dependency. Integration must consume the
current owners' actual fixed sources. #364 owns shared migration/retain/session/
pool work; #161 owns daemon helper/broker changes. This patch does not replace
those sources or publish over #316's active branch. Its old migration timestamps
still require the current-main compatibility composition from the shared owner.

## Verification and remaining gates

`test:self-improvement-semantic-source` explicitly disables tsx disk cache, whose
old default can delete expired/legacy cache directories. Its five source-only
entries use synthetic/in-memory dependencies; no PG, provider or destructive
setup/teardown runs. Use the actual local protocol source when dependencies come
from another worktree. This does not make historical broad test wrappers safe.

Before any related broad test/build/CI/push, independently audit the complete
setup/body/teardown/dynamic imports and managed-host lifecycle. Preserve existing
containers, databases, schemas, volumes, directories, processes and logs. No
DROP/DELETE, cleanup, reconstruction or restoration is authorized by a green test.

Release still needs final composed source and full applicable safe CI, actual
Skill compilation/dispatch with authorized Harness identities, bound baseline and
candidate outputs, real model/function acceptance when specifically permitted,
existing independent review/verification/approval, fixed Preview and production
user flow, monitoring/recovery and a sanitized playable PR video. Model OFF,
synthetic tests and default-off paths cannot substitute for these gates. No merge
or deployment is claimed by this source increment.
