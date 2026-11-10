# Inbox production acceptance follow-up

Use this contract to review and run PR #1856's continuation of #1820 through the existing production Inbox driver. It defines source selection, bounded sample discovery, and cleanup. It is not a production pass receipt.

## Observed gaps

The shared Infisical smoke identity returned a normal GitHub integration response with no connected identity or numeric recipient on source 32523d5955479de800a94ba002c551666c4ddeb1. Do not manufacture a notification, connect a personal identity, or broaden an installation to obtain a fixture. The original Inbox inventory covered twenty selected-team issues and eighteen tasks without a PR; its bounded sample does not prove that the account has no review task.

Organization and audit production acceptance remain with the original Team owner and its v5.2 driver. See the [owner's scope confirmation](https://github.com/alexj11324/Mikka/issues/1752#issuecomment-6756866013) and the [Acme scope follow-up](https://github.com/alexj11324/Mikka/issues/1608#issuecomment-6756975643). PR #1856 adds no Organization, governance, or other-team business probe. Real Pro/Enterprise prerequisites and isolated PostgreSQL evidence remain separate from the Inbox result.

## Bounded implementation

The driver reuses the successful-Web Core workflow, shared account queue, existing Infisical identity, and same two smoke secrets. It keeps one Inbox execution step and its existing name, which the recovery reader verifies. There is no dispatch requirement, additional permission, credential path, or Core device/PAT business as a side effect.

Factory discovery uses only the test team selected by `selectAcceptanceTeam` and verified through the normal workspace response. The existence of other workspace choices does not authorize Factory reads in them. The existing personal Inbox suggestion path remains unchanged.

Within that team, discovery follows `/api/issues/search` cursors, requests each issue's existing Factory list, and reads returned tasks without the old per-page or per-issue sample truncation. Every list and flow request carries `x-mikka-workspace-id`; the list's `liveWorkspaceId` and both flow reads' task/issue identifiers must match. Discovery stops as soon as both required real samples are proved, with `stopReason: required_samples_found`, and makes no further task or issue request. This preserves time for the required suggestion transitions and cleanup. Without both samples, the bounds are 10 issue pages, 400 discovery requests, and the driver deadline with 60 seconds reserved for the remaining work and cleanup. A reached bound remains visible in the receipt.

The Factory server limits 50 raw tasks before authority filtering and supplies no task cursor. Empty and short lists therefore retain `complete: false` and `taskCompleteness: unknown_server_limit_before_filter`. Issue-page exhaustion and completion of reads for returned tasks are reported separately. They do not establish that the team or account has no PR.

A real handoff with a complete cached `review.summary`, followed by a second read with the same revision and summary digest that is still a complete handoff, supplies positive summary coverage. A task without a PR supplies the empty-response case. Both are required for early stopping; one sample, unknown checks, or a changed readback cannot stop further discovery. Early stopping leaves enumeration incomplete and does not skip any required suggestion check. Missing samples remain `not_observed`; discovery never creates a task, runs a model, requests GitHub synchronization, or mutates an existing task. HTTP observations establish returned behavior; the version-bound source and PostgreSQL tests establish the absence of a GitHub request on every flow read.

## Source and cleanup contract

The original #1822 selector runs first and keeps its direct-merge contract. Only its `not_pr_1822_merge` result can try the fixed follow-up registration: repository `alexj11324/Mikka`, PR #1856, and branch `fix/backend-production-followup-1608-1820`. The source must equal #1856's actual ordinary merge, whose second parent is its exact PR head. The actual first-parent chain must reach #1822's ordinary merge `32523d5955479de800a94ba002c551666c4ddeb1`, with original head `a0881b748cd089de08db848e30211fbe8a4a0f48`, within the 64-commit bound. A moving PR `base.sha`, a feature branch containing Inbox, or an arbitrary later main commit cannot supply that proof.

Every execution also verifies the official Core workflow's real `workflow_run` event, current main, driver source, exact successful Web deployment and job, and public version. All must identify the same merge. Selection occurs before smoke credentials are read.

The owner's #1752 comment contains one `mikka-inbox-followup-1856` marker with these bindings:

| Field | Required value |
| --- | --- |
| `schema`, `state`, `issue` | `1`, `active`, `1820` |
| `pr`, `branch` | `1856`, `fix/backend-production-followup-1608-1820` |
| `headSha`, `sourceSha` | Actual #1856 head and ordinary merge |
| `originPr` | `1822` |
| `originMergeSha`, `originHeadSha` | The exact original merge and head recorded in this section |
| `startsAt`, `expiresAt` | Active interval of at most 120 minutes |
| `phase` | `inventory`, `fixture`, or `cleanup`; omitted means `inventory` |
| `fixture`, `recovery` | Only the existing closed metadata for the corresponding phase |

The exact comment and marker digest remain pinned. Editing, replacing, releasing, or expiring the marker, or moving the source, stops new business. An already selected route cannot fall back to the other selector after refusal. Each business write and issue page repeats the source/window verification; discovery verifies it again before claiming sample coverage. Cleanup still permits only this attempt's exact journaled suggestion, saved workspace, bound old sessions when authorized, and its own sign-out.

A #1856 fixture needs its own source, inventory run/attempt, nonce, owner, and actual linked GitHub identity. A `32523d59` fixture request cannot be relabeled as #1856. Cleanup recovery likewise requires an earlier attempt of the same run and source, with the exact completed-job journal; this change introduces no cross-source recovery. A failed, incomplete, or cleanup-only run never becomes full acceptance. The receipt names release PR #1856 separately from feature PR #1822.

## Verification

The existing explicit offline guard files cover the selected-team boundary, later issue pages and returned tasks, unknown completeness, wrong-tenant refusals, both source-selection routes, first-parent ancestry, active-window changes, source-bound fixtures, and cleanup. The workflow continues to run these same guard files before production; the follow-up source matches its existing path filter. Product APIs, SQL, migrations, permissions, and workflow job definitions remain unchanged.
