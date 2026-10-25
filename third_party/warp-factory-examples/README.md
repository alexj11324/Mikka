# Warp Factories prompt adaptations

Source: https://github.com/warpdotdev/warp-factory-examples

Immutable commit, resolved from upstream HEAD/main on 2026-10-24:
`84e7c952f1506c4bd2784d96fd40a6f4d6398cad`.

License: MIT, Copyright (C) 2026 Denver Technologies, Inc. The full unchanged upstream license is in [LICENSE](LICENSE); retain it with substantial adapted prompt portions. This notice concerns those portions, not the license of unrelated Mikka code.

Inspected/adapted sources, under the pinned commit:

- [Foreman](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/00-warp-default-agents/agents/foreman/agent.md): dynamic stage entry, selective triage/spec, focused context, session reuse, result review and human handoff.
- [Triage](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/00-warp-default-agents/agents/triage/agent.md): evidence reuse, technical uncertainty versus user ambiguity, avoid parallel duplicate work.
- [Spec](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/00-warp-default-agents/agents/spec/agent.md): batch unresolved questions, record assumptions/trade-offs, objective scaled acceptance criteria.
- [Implement](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/00-warp-default-agents/agents/implement/agent.md): focused root-cause changes, scoped verification, full-diff self-review, honest handoff evidence.
- [Review](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/00-warp-default-agents/agents/review/agent.md) and [multi-harness reviewer](https://github.com/warpdotdev/warp-factory-examples/blob/84e7c952f1506c4bd2784d96fd40a6f4d6398cad/examples/03-multi-harness/agents/reviewer/agent.md): evidence-backed advisory findings, location/impact/correction, contextual comments are not commands.

Adaptations are in `lib/coordinator/instructions.ts` and `packages/daemon/src/agents/run-context.ts`. Coordinator instructions still pass through `preparePrompt` into WorkflowAgent. Shared worker instructions still enter Claude's appended preset, Codex developer instructions and Cursor's initial prompt. Agent custom instructions remain in `lib/agent-runs.ts`'s brief. `lib/agent-system-prompt.json` is untouched; Bot mailbox instructions are separately appended in its route.

Deliberately omitted: mandatory five roles, default triage for every question, one-review-only limit, Warp tools (`complete_task`), factory labels, attribution comments, model/runner selections, draft-spec PRs, worker commits/pushes, automatic PR creation/merge, and unrelated integration skills. Mikka's Coordinator can dispatch implementation only; it cannot pretend its dispatch tool creates a planning run. Mikka plan runs still submit structured spec/split and never edit the repository or run tests. Existing finish, sandbox, permission and daemon publication ownership rules remain authoritative.

The mailbox implementation is new Mikka code informed by the public orchestration design, not copied Warp server code. No Warp AGPL client or proprietary Oz backend was imported or executed. Prompt changes are strategy improvements, not guarantees of LLM compliance. User review should consider the optional wake-budget policy and the more explicit ambiguity/review gates described in the implementation report.

The subsequent user-directed proactive policy is documented in `docs/implementation/proactive-coordinator.md`. Upstream Foreman already advances most stages automatically and routes clear rework without human decisions; Mikka now makes context discovery, reversible defaults, end-to-end acceptance, bounded recovery and minimal essential questions explicit. This is an adaptation of its strategy plus the user's instruction, not a claim that upstream lacks initiative. Full MIT notice and existing gates remain preserved.
