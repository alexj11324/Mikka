# CC Factory v1 — failed contract and normal cancellation

Application build: `f2db127431737cd6d5ca3c338c76ec7021be433f`. GitHub Actions Web deploy 41882764777 completed successfully; public version reads at 18:06:59.779Z and 18:28:30.618Z on 2026-11-04 returned this build.

This case is **not passed**. It was submitted once through the normal Owner group UI at 18:12:34.547Z. The original contract incorrectly required the independent review/verify stages of a deliverable to execute Python. Those stages intentionally use a read-only, report-only artifact checker. The observed failure is preserved, and no Owner acceptance was performed.

## Frozen input and identity

- Group: `0e4617b2-a68b-4187-9a3f-8c5584e0da62`.
- Owner message: `c1ec51d8-10d1-4aee-b23f-738493f6be33`.
- Issue: `036b1450-662a-435b-befa-f8f1d579bb3a` (ALEX-42).
- Factory task: `98c9ef53-e6bd-44a3-8f33-2cc8909550f2`.
- [original-prompt.txt](original-prompt.txt): canonical submitted text is 2,281 UTF-8 bytes with SHA-256 `f804958ac97bdae5975743c39ea4eb181039159b0589703cd7608e9d89fbb1c2` after removing the file's final LF.
- Requested file: `mikka-group-policy-v3-cc-20261104-1812.txt`, 52 bytes, SHA-256 `05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`.

The workspace had one explicitly prepared preference: the original official Claude Code subscription, `claude-haiku-5-5`. All five recorded runs froze that same model, subscription source and `claude_code_cli` route, with one native claim each. The fifth run failed while starting its hosted runtime and has no recorded native SID. No alternative model or API key was used.

## Actual sequence

| Stage | Run | Native SID | Result |
| --- | --- | --- | --- |
| Execute | `4d87420b-d376-4690-8410-fd89314f903b` | `b0b39c80-eb00-443d-8789-e0da9d231fdc` | Actual Bash creation and Python byte/hash assertions, exit 0; Factory passed. |
| Review | `836c475a-8498-4200-814b-4726eb825f21` | `79ac42c8-51a2-49c7-a559-4041e2bd89fb` | Actual independent inspect_artifact matched the committed snapshot. Report explicitly says Python was not executed; Factory review passed its reported artifact checks. |
| Verify | `e5afc195-793c-4c18-83c0-9b6bd8bbaa1b` | `a6101619-7ebd-4066-aee1-23059cb9a39c` | Actual independent artifact read matched; criterion 4, fresh command execution, was false. Run submitted normally, Factory verify failed. |
| Automatic repair execute | `88ed7cca-ad0e-420f-8103-3a13cfa6a6c7` | `b8cf55ac-5e9d-460a-90a2-57a0be1b45f5` | Automatic successor, passed. No second Owner dispatch. |
| Automatic repair review | `25b60832-a063-46e1-860c-15c7bd84a977` | null | Factory attempt cancelled; run ended failed with subscription_hosted_runtime_unavailable. These distinct states are preserved. |

The first candidate was `45eabaf4-c11e-420d-83c5-17d5e3dc2839`; the host's fixed deliverable snapshot was `c112b45298756761823109c41651b4778def36f2`. The repair candidate was `b634b501-1267-46fb-8d96-60b312f78982`. There was no external repository push or PR.

## Why the old criterion was incompatible

The actual persisted check configuration has `command:null`, `reportOnly:true`, `inferCommand:false`, and read-only permissions. At the deployed commit:

- [lib/factory/checks.ts](https://github.com/alexj11324/Mikka/blob/f2db127431737cd6d5ca3c338c76ec7021be433f/lib/factory/checks.ts) selects this configuration for deliverable/report candidates and instructs the checker to report missing command capability honestly.
- [packages/daemon/src/agents/run-context.ts](https://github.com/alexj11324/Mikka/blob/f2db127431737cd6d5ca3c338c76ec7021be433f/packages/daemon/src/agents/run-context.ts) grants factory artifact inspection to report-only checks; command verification is a separate mode.
- [packages/daemon/src/agents/mikka-mcp.mjs](https://github.com/alexj11324/Mikka/blob/f2db127431737cd6d5ca3c338c76ec7021be433f/packages/daemon/src/agents/mikka-mcp.mjs) exposes the verifier tool only for that separate mode.

The old prompt and failed criterion were not changed. The new proposed v2 contract uses an entirely new task/file and asks only execute to run shell, with independent inspect_artifact observations in review and verify. As of this evidence capture, v2 had **not** been sent.

## Normal cancellation and final read

The Owner sent one normal control message to the Coding Bot. The actual cancel request used a fresh event ID `854bb6bf-628e-4fdc-b486-99ac823f97e3`, current binding revision 16, and action cancel. The persisted receipt at 18:20:38.570Z returned cancelled revision 17. The UUID was explicitly supplied by the operator, so this does not prove that the model independently inferred the #1240 event-ID rule.

At 18:26:23.384Z, a read-only production query confirmed cancelled revision 17, **zero active runs and zero unexpired leases** for this Factory task. All original attempt outcomes and the failed fourth verify criterion remain intact.

The temporary priority configuration was still byte-for-byte equal to the prepared post-state at 18:27:47.440Z, fingerprint `fa007e76d8e33b9cf4eaa0845ca07d53722b7e6e15192c5622abaa893ce3c9ca`. Restoration had not yet occurred because further authorized Claude acceptance was paused pending deployment. No secret values are included.

## Evidence

- [initial-native-claim.json](initial-native-claim.json), [producer-tools.json](producer-tools.json).
- [independent-checks.json](independent-checks.json), [candidate-report-only.json](candidate-report-only.json).
- [group-reports-and-stages.json](group-reports-and-stages.json).
- [cancel-request-receipt.json](cancel-request-receipt.json), [final-runs-zero-leases.json](final-runs-zero-leases.json).
- [cancelled-confirmed.png](cancelled-confirmed.png): actual normal production UI showing failure preservation and cancelled revision 17. Automatic prose in the chat is retained as evidence; its suggestion to grant more command capability is not adopted.
- [group-raw-links.png](group-raw-links.png), [group-link-bug.json](group-link-bug.json): the group's Task/Thread Markdown is displayed as plain text, an independently tracked UI defect.

These are production observations of this one authorized acceptance case. They do not claim original Codex 390 recovery, a completed CC v2 task, Codex group acceptance, API acceptance, or issue closure.

