# Independent acceptance evidence

Date: 2026-11-20

Status: Accepted

Source: [#2889](https://github.com/alexj11324/Mikka/issues/2889),
[#2888](https://github.com/alexj11324/Mikka/issues/2888), and
[#2891](https://github.com/alexj11324/Mikka/issues/2891).

## Decision

Acceptance uses a runner and a separate checker. The runner proposes scope,
then exact execution steps, operates the environment, and captures evidence.
The checker reviews both plans and the final evidence without performing that
execution or repairing its implementation. The issue owner owns fixes and merge.

Each check declares `requiredEvidence`. Missing evidence or source/environment
binding yields `uncertain`; observed behavior that contradicts the contract
yields `fail`; only complete supporting evidence yields `pass`. A queued,
cancelled, skipped, or draft-only check is never accepted. Existing evidence
can be reused when its immutable source and environment still cover the change.

[`.agents/acceptance/PROCESS.md`](../../../.agents/acceptance/PROCESS.md) owns
the handoffs and verdict rules. `PROJECT.md` owns actual Mikka commands and
boundaries. Claude Code and Codex skills point to these shared documents;
`AGENTS.md` keeps the governing pointer instead of duplicating the procedure.

The deterministic `PR acceptance` status validates the declaration in the PR
body. It is bound to the current head, reads metadata without executing the
PR's code, and maintains `acceptance:missing`. It does not decide whether the
evidence proves the behavior. Alex enables the additional required commit
status in branch protection after the implementation merges.

## Consequences

Independent review and version-bound artifacts make a claimed result
reviewable. The extra handoffs are technical review within the already
authorized task, not repeated permission requests. A blocker is reported with
the missing evidence or real error; it is not converted into a green result.

The [scripted model decision](2026-11-20-1855-scripted-model-acceptance.md)
continues to govern execution. Both runtime paths use model responses at the
LiteLLM boundary, and acceptance databases stay on local PostgreSQL 17
`*_e2e` targets. This workflow creates no model-key or Neon-branch prerequisite.
