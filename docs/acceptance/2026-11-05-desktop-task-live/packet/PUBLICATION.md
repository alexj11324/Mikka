# Desktop task list live updates — review checkpoint

Application candidate: [`526abe89100fd3079671136510629719fc4fb397`](https://github.com/alexj11324/Mikka/commit/526abe89100fd3079671136510629719fc4fb397). Base: `40d03479ea8260b8934f609b84c7c9cb60a94b3c`. Application tree: `d9faf9e04129555fc5251ef493e7f82702c0588d` (GitHub equals the actual isolated worktree).

**This is a draft code and evidence checkpoint. No production or one-hour measurement result is claimed; main is unchanged by this candidate.** Related tracking issue: #1212.

DesktopIntegration now consumes the existing Owner task-run list hook instead of its own 15-second loop. The internal consumer mounts only on desktop, resets its baseline per Owner and discards old Decision/click callbacks after unmount. The shared live hook, read authorization, notification content, preferences contract and Decision model/service remain unchanged.

- [完整中文审阅说明](packet/README.md) — this file preserves the pre-publication review state.
- [独立审阅](packet/INDEPENDENT-EGRESS-REVIEW.md) and [machine-readable review](packet/INDEPENDENT-EGRESS-REVIEW.json).
- [Actual patch](packet/evidence/candidate.patch), [tested candidate and dependency identities](packet/evidence/candidate-metadata.json), [later main integration receipt](packet/evidence/integration-40d-receipt.json).
- [Same-fixture old-product RED](packet/evidence/red-final.log): 16.1017 seconds, task reads 1 → 2.
- [Final combined GREEN](packet/evidence/green-final.log): 31/31, no skips; 18 Desktop and 13 existing real React/SWR list cases. Desktop reads 2 → 2 across 16.1023 seconds.
- [Type/lint/navigation exits](packet/evidence/static-final.exits). The initial fixture typing failure is retained in the raw packet.
- [Warning trace](packet/evidence/hidden-warning-trace.log) and [existing SWR callback](packet/evidence/swr-focus-callback.json). Node's experimental/deprecation/NaN warnings are retained, not suppressed.
- [Cleanup receipt](packet/evidence/cleanup.json): owned Node/typecheck processes empty, no task-created DBs or roles; shared PG and Sandbox remain running.
- [Original evidence archive](packet/desktop-live-evidence.tar.gz) and [warning-trace supplement](packet/desktop-live-warning-trace.tar.gz).
- [Complete packet manifest](packet/packet-manifest.json).

The tests ran on the prior `5d2011f…` base. Normal fast-forward integration then preserved all seven release-control files from `40d0347…`; all three candidate blobs and eleven dependencies are unchanged. No unrelated test rerun is presented as additional coverage.

The fixtures run the real component, React, SWR, list hook and live channels; service actions, authenticated-ticket/WS transport, platform and native shell are controlled boundaries. They do not prove native Electron or production behavior. The existing global `preferences` cache has no Owner attestation and is expressly outside this patch's cross-Owner claim. No screenshots are fabricated: the component renders no page DOM, and notification presentation/link rules retain their exact existing blob. Release and issue-body measurement gates remain pending.
