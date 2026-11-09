# Agent as Code

This implementation reference describes declarative Agent definitions, shared tools, evaluations, immutable execution provenance, lazy Skills, registered hooks, import/export and controlled improvement proposals. It records the backend scope Alex requested on 2026-10-26. Runtime acceptance follows [acceptance.md](../acceptance.md).

## Ownership boundaries

- Agent Kit (`lib/agent-kit`, `agents/`) defines and validates capabilities, materializes trusted repository assets, pins definitions, evaluates behavior and manages guidance candidates.
- The selected AI SDK / Claude Code / Codex harness remains the sole model/tool loop. The native Coordinator transport remains a relay, not another LLM loop.
- Existing Workflow, daemon, leases, MCP, account approval and workspace authorization remain authoritative. Declaring a tool never grants permission to run it.
- Conversation, memory, leases and task state remain runtime data. No private conversation or memory is exported with an Agent definition.

## Rollout

The additive `20261027181000_agent_kit.sql` migration runs through the normal deployment migration flow. Versioned definitions are enabled by default in `lib/agent-kit/config.ts` and `lib/deployment-switches.ts`. The PostHog `mikka-agent-kit-off` kill switch and legacy `MIKKA_AGENT_KIT=0` override retain the disabled path. Live evaluation has its separate paid-use gate. The selected harness remains part of the run definition.

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

`fixture` is a plumbing smoke test with synthetic output. It cannot activate a candidate. `live` performs real model inference against the same tool schemas, but replaces **every tool implementation** with an inert synthetic fixture before execution. It cannot send mail, edit calendars, write memory or dispatch a worker. Live evaluation requires the `agentKitLiveEval` deployment switch (`mikka-agent-kit-live-eval`, with legacy `MIKKA_AGENT_KIT_LIVE_EVAL=1`) and explicit request consent to model usage. It is not native-CLI, real-account, browser or production acceptance.

Failures produce structural, synthetic regression cases, not copied private conversations. At least three distinct failed executions of the current definition are needed for a proposal. The current generator is deliberately rule-based: it proposes additive reliability guidance for the observed failure categories. It does not claim autonomous model training or guaranteed improvement.

Candidates can change **instructions only**. Tools, hooks, Skills, evaluation suite, memory scope and permission boundaries remain frozen. Candidate creation does not activate it. Baseline and candidate run against the same frozen case set/model/runner. Activation requires a completed live comparison, matching revision digests, no regression, all candidate cases passing, a strict improvement, an unchanged active baseline and explicit authenticated human approval. Synthetic fixtures or a client-supplied score cannot satisfy this gate. Existing active versions can be rolled back by the owner.

Skill artifact publication and Factory review/verification in #316 remain separate and are not merged, overwritten or claimed complete here. This feature does not auto-deploy code, widen permissions, add a second Skill-activation mechanism, or auto-approve its own changes.

## Verification scope

Run the pure definition/loader/tool/eval/HTTP suite with `pnpm test:agent-kit`. `pnpm test:agent-kit-db` uses only the existing Actions loopback service or an explicitly named isolated cloud-sandbox database; it refuses application/cloud URLs. The actual migration is applied repeatedly, and concurrency, immutable snapshots, tenant isolation, idempotency, proposal gates and HTTP-to-Postgres paths are exercised. Existing native relay and scope tests remain mandatory.

Passing these suites establishes implementation contracts. Report real model comparisons and authenticated acceptance separately, with the exact revision and environment. Model-execution acceptance covers official Claude Code subscription (`claude-haiku-5-5`) and official Codex subscription (`gpt-6-luna`) under [acceptance.md](../acceptance.md). Record a blocked subscription independently and continue the other path. API-key execution does not gate acceptance.

## Current main compatibility

The shared registry retains main's attention decisions and optional Bot-computer tools. The cloud catalog is advertised only when the existing computer/BYOS feature gate is enabled; a definition selecting an unavailable capability fails closed. Existing saved definitions retain their explicit tool list. The fresh built-in definition includes `record_attention`; adding it or cloud capabilities to an existing definition is an explicit versioned edit, not an automatic permission expansion.

Both local and cloud dispatch capture the standing worker instructions and, when selected, the exact subscription binding/model/route as non-secret snapshot metadata. Claim and retries preserve that selection and refuse a missing, changed or disabled pinned subscription instead of choosing a later binding. Cloud retries preserve the task's dedicated machine binding. These source contracts do not establish real CC/Codex or provider execution.

The migrator recognizes the Agent Kit migration's former filename only with its approved exact SQL hash. Migration counts and review results belong to the revision-bound CI evidence.

Admission and claim validate the owned device and frozen subscription against the execution snapshot. The [machine authority decision](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md) governs native CLI authentication and direct provider calls. Other third-party Secrets follow the separate [exposure decision](decisions/2026-11-08-0240-credential-exposure-boundary.md). The source implementation separates ordinary/direct environment values from protected capabilities under [task Secret delivery](../security/task-secret-delivery.md). Deployment and runtime protection need their own evidence. Run views display the frozen harness when recorded. Native request and lease-retry SQL require matching isolated PostgreSQL evidence for the tested revision.
