# Factory as code (v1alpha1)

Decision date: 2026-10-29. References Warp Factories, which Mikka's Factory
workflow was modelled on.

## Decision

Mikka adopts the Warp Factories trust model:

1. **The version authority is the reviewed factory definition on `main`.** The
   whole definition is one versioned tree rooted at `factory.yaml`. It is
   validated in pull requests, applied as one unit, and the last valid
   definition is retained when validation fails. A Factory task or run records
   the definition digest it started under, so a mid-flight configuration change
   cannot silently change its authorization.
2. **Humans approve work; repositories enforce merges.** A person signs off a
   spec when one is required, and a person merges pull requests. Factory agents
   open pull requests and never merge. Branch protection and repository
   permissions are the enforced control, not an in-application membership
   check.
3. **Review is advisory.** The review agent's verdict is retained as evidence.
   It is not a cryptographic publication attestation and it does not grant
   merge authority. There is no mandatory `reviewKey` issuer.
4. **Configuration is code.** Changes reach production through a pull request
   that runs the factory-config check. Self-improvement proposals are pull
   requests; nothing is applied on its own.

This supersedes the earlier expectation that `FactoryPublicationHost.policy()`
and `reviewKey()` must be backed by a separate signed policy service and a
production attestation key. Those seams remain available for optional,
stricter deployments, but they are not required for the default model.

## What the definition contains

The v1alpha1 subset is deliberately small and strict; unknown keys are
rejected so typos cannot be silently ignored.

```yaml
schemaVersion: v1alpha1
name: mikka
repositories:
  - owner: alexj11324
    name: Mikka
agentDefaults:
  harness:
    type: codex
    model: default   # logical profile, resolved by the host configuration
  runner: linux-default
  secrets: []
credentialStrategy: creator
runners:
  - name: linux-default
    os: linux
    arch: x64
    instanceShape:
      vcpus: 2
      memoryGb: 4
secrets: []
```

- `repositories` names the code forges a factory may act on.
- `agentDefaults` declares exactly one of `model` (Warp-style shorthand) or
  `harness` (`oz`, `claude`, `codex`, `claude-code`). `model` is a logical
  profile name in v1alpha1; the host maps it to a concrete provider model.
- `credentialStrategy` is `creator` (act as the person who started the run) or
  `executor` (act as the agent for unattended work). Repository actions are
  attributed accordingly.
- `runners` declare OS, architecture, instance shape and image. A run is bound
  to one runner shape for budgeting.
- `secrets` are **names only**. Values live in the managed secret store and are
  granted to specific agents; a definition can never carry a secret value.

## Credentials

Four boundaries remain separate, as in Warp Factories:

| Credential | Boundary |
| --- | --- |
| Inference | Used at the model-provider boundary, never injected into a sandbox |
| Execution secrets | Per-agent allowlist (`agentDefaults.secrets` / agent override) |
| Harness authentication | Used inside the execution environment for direct provider calls |
| Repository identity | `credentialStrategy` selecting creator or executor identity |

An agent receives only the secrets explicitly granted to it. Anthropic-style
output redaction is a backstop, not a substitute for least privilege.

## Execution and budget

A runner declares the resource shape; `workerHost` (added when self-hosted
workers are deployed) selects where it runs. Warp-hosted shapes are bounded by
the plan; self-hosted capacity is bounded by the worker. Mikka additionally
requires an explicit per-run and per-user budget cap before per-thread machine
provisioning is enabled, because provider spend is not authorized by a schema
migration.

## Rollout

1. **This change:** definition, strict validator, digest, CI check, tests.
   No production behavior changes.
2. Wire `FactoryPublicationHost` to the applied definition digest, make
   `reviewKey` optional, and keep review as advisory evidence. Publication is
   limited to opening a pull request; the application never merges.
3. Per-agent secret allowlists and `credentialStrategy` execution.
4. Runner shapes, `workerHost` and hard budget caps for per-thread machines.

## Non-goals

- No in-application merge authority.
- No secret values in the definition or in prompts.
- No self-approved publication: an agent cannot approve its own work.
- No claim that a passing factory-config check proves provider acceptance.
