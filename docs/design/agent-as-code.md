# Agent as Code

Alex requested the full Agent-as-Code engineering layer on 2026-10-26: declarative definitions, shared tools, evaluations, immutable execution provenance, lazy Skills, registered hooks, import/export and controlled improvement proposals. This change is backend-only. Bot creation, layout and native coding sessions remain unchanged.

## Ownership boundaries

- Agent Kit (`lib/agent-kit`, `agents/`) defines and validates capabilities, materializes trusted repository assets, pins definitions, evaluates behavior and manages guidance candidates.
- The selected AI SDK / Claude Code / Codex harness remains the sole model/tool loop. The native Coordinator transport remains a relay, not another LLM loop.
- Existing Workflow, daemon, leases, MCP, account approval and workspace authorization remain authoritative. Declaring a tool never grants permission to run it.
- Conversation, memory, leases and task state remain runtime data. No private conversation or memory is exported with an Agent definition.

## Rollout

Apply the additive `20261027040500_agent_kit.sql` migration to the matching isolated Preview database before enabling `MIKKA_AGENT_KIT=1` on that Preview. The flag is off by default; no production configuration is changed by this PR. With the flag off, Coordinator tools and prompts follow the old path. Enabling does not change the user's selected harness.

A new execution records an immutable definition revision, content digest, exact host instructions and their digest, effective tools, and the selected runtime/model where known. An execution replay reuses that record even if the user edits the Bot. Memory is loaded separately under the current owner/Bot scope. The host prompt snapshot is not a model's hidden internal system prompt and does not claim to capture provider-internal state.

Worker dispatch atomically records the worker's standing instructions, harness, prompt digest and parent Coordinator revision. Device-loss retries preserve the definition and parent, while updating the changed retry-brief digest. Historical rows remain null/unrecorded. Native-default model selection is explicitly unknown; a configured harness is not proof a model executed.

## Definitions and tools

`agents/default/agent.json` has no additive instructions or Skills, preserving the existing default host behavior. File-backed and database-backed definitions share one strict schema. Developer Markdown references are materialized by a confined loader. HTTP imports reject paths, unknown fields, executable code, unknown tools/hooks and cross-user memory scopes.

The `workflows/coordinator/tools.ts` registry owns executable definitions. Both native and AI SDK paths select from it. Tool audit hooks retain only the tool name, safe outcome category and stable call ID: no arguments, outputs, credentials or memory. A hook cannot replace a tool or grant approval. Audit events are idempotent and immutable.

Bot Skills use progressive disclosure: only the catalog enters instructions. `load_skill` resolves the body against the execution's pinned definition. Native coding workers retain their existing Skill mounting contract; this change does not replace the separate immutable Skill/Factory work in #316.

## HTTP contract

`/api/bots/{botId}/definition` also accepts `coordinator` for the built-in personal Coordinator. Authentication uses the current server session; user and workspace scope are host-derived. Bot operations require ownership and current active workspace membership. POST requires an exact same-origin `Origin` header and bounded JSON. Every response is private/no-store.

GET returns the active version. `?view=export` returns a checksummed materialized document; `history`, `dataset` and `proposals` return scoped records. `?view=execution&id=<uuid>` returns one owned execution snapshot.

POST commands:

| action | Required fields |
| --- | --- |
| save | definition, expectedVersion, requestId |
| import | document, expectedVersion, requestId |
| rollback | targetVersionId, expectedVersion, requestId |
| propose | expectedVersion, requestId |
| evaluate | proposalId, requestId, mode (`fixture` or `live`), consentToModelUsage |
| approve | proposalId, evaluationId, expectedVersion, requestId, confirm: true |
| reject | proposalId |

Version writes use a locked head, optimistic version checks and idempotency keys. A stale write returns 409 rather than silently replacing a newer decision. Rollback creates an activation record; it does not rewrite immutable versions. An unevaluated generated candidate cannot be activated by calling rollback.

## Evaluation and improvement

Evals check observed tool use, known fixture facts, nonempty replies, outcome categories and the no-unauthorized-effect boundary. They do not prescribe an entire tool sequence. Test code fixes the core cases and thresholds; a definition cannot edit them.

`fixture` is a plumbing smoke test with synthetic output. It cannot activate a candidate. `live` performs real model inference against the same tool schemas, but replaces **every tool implementation** with an inert synthetic fixture before execution. It cannot send mail, edit calendars, write memory or dispatch a worker. Live evaluation requires both `MIKKA_AGENT_KIT_LIVE_EVAL=1` and explicit request consent to model usage. It is not native-CLI, real-account, browser or production acceptance.

Failures produce structural, synthetic regression cases, not copied private conversations. At least three distinct failed executions of the current definition are needed for a proposal. The current generator is deliberately rule-based: it proposes additive reliability guidance for the observed failure categories. It does not claim autonomous model training or guaranteed improvement.

Candidates can change **instructions only**. Tools, hooks, Skills, evaluation suite, memory scope and permission boundaries remain frozen. Candidate creation does not activate it. Baseline and candidate run against the same frozen case set/model/runner. Activation requires a completed live comparison, matching revision digests, no regression, all candidate cases passing, a strict improvement, an unchanged active baseline and explicit authenticated human approval. Synthetic fixtures or a client-supplied score cannot satisfy this gate. Existing active versions can be rolled back by the owner.

Skill artifact publication and Factory review/verification in #316 remain separate and are not merged, overwritten or claimed complete here. This feature does not auto-deploy code, widen permissions, add a second Skill-activation mechanism, or auto-approve its own changes.

## Verification scope

Run the pure definition/loader/tool/eval/HTTP suite with `pnpm test:agent-kit`. `pnpm test:agent-kit-db` uses only the existing Actions loopback service or an explicitly named isolated cloud-sandbox database; it refuses application/cloud URLs. The actual migration is applied repeatedly, and concurrency, immutable snapshots, tenant isolation, idempotency, proposal gates and HTTP-to-Postgres paths are exercised. Existing native relay and scope tests remain mandatory.

Passing these suites establishes implementation contracts, not model quality. Real model comparisons and authenticated frozen-Preview acceptance must be reported separately, with their exact version and any missing authorization or configuration.
