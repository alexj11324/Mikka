# Credential exposure is distinct from execution-machine authority

- Date: 2026-11-08 02:40 UTC
- Source: Alex's correction to the interpretation of [#1505](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691833153): 「我当时是要求，就是说执行机器直接持有的是GitHub的credential，没让他就是说把所有的这个密钥都给到这个执行机器啊。」 This clarifies the scope of credential delivery, not the [removal of repeated remote authorization](https://github.com/alexj11324/Mikka/issues/1505#issuecomment-6691871552).
- Rule: Task-machine execution, credentials, user/workspace/repository Secret delivery, cloud and local runners.
- Replaces: Only the interpretation of [2026-11-06-1800](2026-11-06-1800-machine-is-the-execution-boundary.md) that all task-reachable user/workspace/repository Secrets should be exposed directly to an Agent. Its native execution, GitHub, model-provider direct connection, and no-per-call-control-plane authorization rules remain in force.
- Status at decision time: Effective architecture decision. Runtime migration is **not yet implemented** and requires a separate issue. See the dated source implementation status under Migration for the later source snapshot.

## Boundaries and threat model

**One task, one VM** is isolation **between tasks**, not secrecy **from an Agent running arbitrary commands within that VM**. The Agent can potentially read its own environment, files, process credentials and HOME. Log masking is useful defense in depth but does not establish a confidentiality boundary.

The previous 2026-11-06 performance decision was justified: never send every native model request or tool call through Mikka's control plane for fresh permission checks, repeated database queries, or provider-token forwarding. Keep the direct execution path.

Distinguish these classes of authority:

| Class | Decision |
| --- | --- |
| **Task GitHub credentials** | Direct delivery is allowed when native Git, gh, cloning, pushing and PR creation genuinely need it. Restrict to the authorized repository and least privilege/short life where possible. Prepare once, use native Git/gh; do not add a Mikka remote permission RPC to each Git operation. |
| **Selected Claude Code / Codex credentials** | The real subscription login or selected model API key required by that run's native CLI may be supplied through its supported credential mechanism. Do not deliver every other model credential. Preserve native provider protocol, ordinary HOME and direct provider calls: no placeholder-token/provider-forwarding or per-call authorization proxy. Refresh expiring auth in the background where required. |
| **User, workspace, repository third-party API Secrets** | **Do not automatically give plaintext to an arbitrary Agent environment, file, HOME or prompt.** Grant scoped service/API capabilities for a run. Prefer non-readable network-egress authentication injection or a narrow authorized MCP/tool operation where technically supported. No general-purpose Agent plaintext-read API. |
| **Non-sensitive configuration variables** | Keep ordinary environment-variable injection and current workload compatibility. Distinguish explicitly from secrets; a UI mask or environment-variable name is not a security boundary. |
| **Mikka platform secrets** (Infisical identities, DB/deployment admin keys, signing keys) | Remain on trusted platform services; do not bulk-sync or inject into user task machines. |
| **Saved website logins and sessions** | Continue the separate AWS KMS Credential Broker/browser path. Do not merge it with coding-task API Secret handling. |

## Execution design and performance invariants

1. At initial dispatch/claim, Mikka validates the owner, workspace, repository, task, frozen model and selected CLI/GitHub identity, and the narrowly requested third-party secret capability. A running task should not make a second Mikka control-plane authorization trip before every model request or tool invocation. Revocation uses existing push-stop/reclaim semantics; providers and tools still perform the normal authorization inherent in their actual API operation.
2. For compatible HTTP third-party APIs, a dedicated **egress-side** injector may attach a scoped credential after a request crosses the Agent-visible boundary. Define explicit service/host/HTTPS/redirect/operation scope, ownership, revocation, rotation and leakage controls. Do not automatically attach secrets to arbitrary destinations or redirect targets. No database reads or Mikka authorization RPC per API call; any fast local binding/cache must be explicitly constrained and benchmarked. This is **not** the old Mikka model-provider proxy.
3. A network injector is not universally compatible. For SDKs requiring the plaintext in-process, non-HTTP protocols, request-signing credentials or tools that construct custom authentication, support a documented alternative: a narrow trusted tool, scoped/ephemeral credential, or **explicit per-secret direct-exposure mode** with clear risk disclosure. Do not silently break existing workloads or silently fall back to plaintext.
4. A proxy may add latency; never claim it is free. Measure its p50/p95 overhead separately from startup/claim, database calls and provider/model TTFB. Native GitHub and official CLI model traffic must not regress or acquire new Mikka per-call checks. Preserve #1505's production target as an independent performance issue.
5. An Agent may abuse the **authority** of an allowed API request even when it cannot see a secret; endpoints may reflect sensitive values. Origin binding, method/route restrictions, minimum capability, audit and explicit residual-risk language remain necessary. Do not claim that Mikka's trusted backend, a third-party provider, or a compromised host cannot ever see plaintext.
6. Local user-owned devices do not automatically provide a strong confidentiality boundary against malicious processes with the same OS permissions. Avoid claiming a same-user sidecar solves that threat. Preserve normal local worktrees and CLI behavior.

## Migration, compatibility, and acceptance

### Source implementation status, 2026-11-08

Source revision `5998ce48972937a1104b4a427af5bd73a699d83a` includes the task-secret
capability path. `taskSecretInjection()` separates ordinary environment and
approved direct values from protected Secrets and unavailable names.
`effectiveSecretDelivery()` defaults missing or invalid delivery metadata to
protected. The device claim checks daemon capability and issues a sealed grant
inside its final response fence, bound to the run, attempt, device token,
owner, workspace and repository. The source paths are
[`runtime.ts`](../../../lib/secrets/runtime.ts),
[`delivery.ts`](../../../lib/secrets/delivery.ts),
[`task-access.ts`](../../../lib/secrets/task-access.ts) and the
[device claim route](../../../app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts).

This source inspection records implementation presence at that revision.
Deployed migration, protected-secret canaries, local and E2B acceptance, and
performance require their own version-bound runtime evidence. The original gap
recorded below describes the implementation at decision time.

- **Gap recorded at decision time:** The current lib/secrets/runtime.ts taskSecretInjection() decrypts user/workspace/repository values and returns a plaintext environment map; app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts delivers it to a cloud runner. The existing runtime therefore **does not yet meet** this new protected-secret default. Documentation does not change deployment behavior.
- The implementation owner inventories every secret origin/destination, separating ordinary env from sensitive values, and tests both E2B and local daemon, native CLI/GitHub, connected-app/MCP and browser-login cases. Preserve working environments through an explicit compatibility/migration plan, not an unreviewed removal of task env injection.
- Protected-secret canaries must not be readable through the Agent prompt, environment, command output, files, traces, screenshots, checkpoints or templates; verify cross-owner/workspace/repository/run isolation, wrong origin, redirects, revocation and rotation. Report any unavoidable exposure modes as such rather than claiming absolute invisibility.
- No new periodic polling, no model-proxy resurrection, no per-provider/per-tool control-plane auth, no change to official Claude Code/Codex files, no weakening task ownership or GitHub operations. Preserve self-hosted behavior.
- Compare before/after metrics on the same fixed app/worker/template versions: time to actual Agent task acknowledgement and p50/p95 latency for native model/GitHub and protected third-party API calls. Do not label broad #1505 startup latency as a Secret-proxy regression without stage evidence.
- Do not modify production credentials, Infisical identities, Secret Syncs or account permissions as part of the documentation change.

The older [2026-11-06-1800 ADR](2026-11-06-1800-machine-is-the-execution-boundary.md) continues to govern the one-task-one-VM execution boundary, native CLI/Git, startup and no repeated remote checks; **this ADR controls only the confidentiality and delivery scope of other Secrets**.
