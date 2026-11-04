# Group issues: implementation and remaining acceptance

Snapshot: 2026-11-04, after main `47ccb5b4cce5452e410c3b62015f0d3f7d7d1df9` was confirmed on canonical production build `dpl_BvAfsXroKuPVG8WWwVkzNVm1x96A` by the release owner. The next full production core run has not yet supplied a passing result in this record. Do not close these four issues from implementation/CI alone.

Evidence owners:

- [#1170](https://github.com/alexj11324/Mikka/pull/1170): original group routing, public role/capability catalog, durable Factory delegation, single reporter, trace and evaluation integration.
- [#1193](https://github.com/alexj11324/Mikka/pull/1193): sequential Decision protocol, bounded genuine receipt chain, complete known/unknown routing cost, explicit multi-mention delivery, pending/cleanup acceptance updates.
- [#1196](https://github.com/alexj11324/Mikka/pull/1196): dedicated physical group-worker session, socket-loss fences and generator abort; actual PG reproduction and green regressions.
- [#1197](https://github.com/alexj11324/Mikka/pull/1197), [exact CI 41772548774](https://github.com/alexj11324/Mikka/actions/runs/41772548774): PostHog policy rollback, attempt/step version freezing, fixed 24-case collector, 33 source + 19 real PG tests (zero skips), full checks passed before merge.
- Actual production [41762211922](https://github.com/alexj11324/Mikka/actions/runs/41762211922) and [41769516026](https://github.com/alexj11324/Mikka/actions/runs/41769516026) are **failed evidence**, not successful acceptance. The latter recorded `interrupted_generation_not_replayed` for the first group scenario and one paid uncertain baseline replay. Neither reached a group Factory task.
- [Real local 6655 evidence](https://github.com/alexj11324/Mikka/blob/a36e09858e53db54844d43e2c6219c01f0c43f55/.github/pr-evidence/1190-acceptance-merge/real6655-review.md): offline device handoff and real Factory execute/review/verify/merge passed. This is adjacent Factory evidence, not proof of the group→Factory entry path or Cloud/official-subscription/Gmail acceptance.

## #1157 — value-based group decisions

| Acceptance item | Current evidence | Remaining real acceptance |
| --- | --- | --- |
| Casual chat, already-answered closure and unrelated content produce no wake/generation/publication | Implemented ignore/observe and normal silent completion; DB/Decision contracts in #1170/#1193/#1197 | Full core proves one casual case when it passes; prepared routing addon must still run natural chat, closure and unrelated cases. |
| UI, Coding and Testing requests select only the suitable primary | Host public roles/catalog and sequential semantic selection implemented; synthetic/unit/PG checks pass | Core covers UI and explicit Testing; unmentioned Coding/Testing require the routing addon. |
| Multiple requested contributions are sequential and incremental | Max three responders/rounds, de-duplication and contribution gating implemented; PG/source checks pass | Real multi-member incremental response remains in the unexecuted routing addon. |
| Authorized mentions deliver; nonmembers are rejected | Single/multiple mentions and membership revocation are host checked; actual generation delivery with contribution=false covered in PG | Core normal mention plus addon nonmember removal/readback/rejection/restoration. |
| Missing/refused/malformed Decision output is not successful silence | Sequential protocol and explicit pending errors; paid invalid receipts/cost preserved; real failed production receipts retained | Fresh production result needed after session/protocol fixes; a failure must remain a failure. |
| Persistent DB + actual fixed-user group end-to-end evidence | Extensive PG and actual failed production samples exist | No passing full production group suite yet in this snapshot. |

## #1158 — public role and real capabilities

| Acceptance item | Current evidence | Remaining real acceptance |
| --- | --- | --- |
| Three-role discussion/task routing with no irrelevant wakes | PublicRole owned API/detail editor and host catalog implemented; normal production fixture setup reached the first group scenario, so role persistence/Flash selection guards passed | Actual full group routing and Factory task selection still pending. |
| Changed public role affects the next message | Fresh directory reads and member digest update are tested | Prepared routing addon changes/restores only its new Coding Bot; not executed. |
| Revoked/offline/disconnected execution becomes unavailable and gives an actionable block | Catalog uses actual execution Bot and host resolver, independent owner/workspace/resource checks; PG covers negatives | Fresh real unavailable-resource scenario remains unproven; do not substitute a mocked capability for an observed production block. |
| Routing contains no private instructions/credentials or unauthorized MCP | Public role source is separate from private instructions; trace/receipt allowlists and multi-user privacy regressions pass | Safe production trace/readback should accompany the new passing run. |
| Agent+Bot mixed groups, Bot-only and multi-user permissions | API/PG contracts cover these source paths | Actual current production acceptance uses one owner; no invented second account or cross-owner live claim. |

## #1159 — group→Factory and a single reporter

| Acceptance item | Current evidence | Remaining real acceptance |
| --- | --- | --- |
| One group request creates one persistent Task/Thread | Host-bound source/operation receipt, reporter binding and requester execution implemented; real PG checks pass | Previous production cores stopped before delegation; new core must show the actual task. |
| Repeated event/message refresh does not duplicate effects | Durable operation receipts, committed-dispatch recovery and idempotent stop/status/reconciler PG coverage | Normal production refresh/status readback after a real task. |
| Continuation updates the same Task's latest request epoch for review/verify | Epoch fencing integrated; versioned artifact association preserves run1/v1 and run2/v2; real PG passes | Driver requires completed second epoch, independent review/verify, exact new bytes, acceptance and one final report—not merely admission. |
| Authorized Cloud/local execution and offline backend progress | Host dispatcher and Factory paths integrated; real local handoff provides adjacent evidence | Actual group Cloud run remains pending; local/Cloud recovery are different acceptance scenarios. |
| One reporter returns server-confirmed results and links after existing gates | Reconciler handles no-repo accepted approval/passed, current artifact version and correct Task/producer-thread URLs; PG passes | New core must show both accepted artifacts via the same reporter, then third-epoch stop. |
| Unauthorized tools/no machine/revoked subscription block honestly | Host capability/identity/admission paths remain enforced; negative PG fixtures pass | No current real official-subscription or revoked-subscription group scenario; do not imply one. |

## #1162 — traces, metrics, reviewed evolution and rollback

| Acceptance item | Current evidence | Remaining real acceptance |
| --- | --- | --- |
| Reproducible fixed baseline/candidate comparison | Fixed anonymized dataset, 12 eligible cases × 2 policies, authenticated normal API, bounded sequential receipts; collector now retains invalid observations and continues without retry | No real 24-case collection yet. Collection completeness and quality acceptance remain separate; any real uncertain baseline/candidate keeps quality failed. |
| Inspectable safe trace separates routing from generation behavior | Context IDs/member hashes, purpose/action/responders, genuine chains, wake/generate/publish/delegate/result events, correction/reaction/cancel provenance; PG and failure receipts exist | Passing production zero reply / one reply / Task paths still needed. |
| Precision/recall/noise/cost/latency per policy | Existing fixed labels and actual safe routes support derived TP/FP/FN with explicit coverage; invalid cases stay unknown/failures. Known paid invalid costs retained, unknown components keep complete total null; cost scope is routing chain only | Publish the actual 24-case report/derived denominators; never convert projected execution into real runtime wake or delegation completion metrics. |
| Reviewed versions and one-click rollback restore previous behavior | Main #1197 uses existing PostHog flag1028528, default candidate; true selects baseline. Each attempt/step is frozen. Root created the flag inactive | Prepared manual rollback addon has only offline contracts. Need operator true/false acknowledgments plus correctly ordered actual trace/provider timestamps; 61s alone proves nothing. |
| No automatic weight training, classifier or positive-feedback auto-promotion | No such mechanism was introduced. Existing human review/versioned source gates remain | This boundary is intentional, not an unimplemented automatic optimization promise. |

The prepared core, routing addon and rollback addon are separate evidence producers. Source/PG contracts, real local daemon results, actual production runtime, fixed Decision inference and manual flag control must retain their distinct scopes in any issue closure note.
