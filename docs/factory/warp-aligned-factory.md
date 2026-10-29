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

## Publication authorization in this repository

`FactoryPublicationHost.reviewKey` is optional. A host that installs a trusted
public key keeps the strict deployment: every publication must carry a signed
review envelope, verified against that key.

The default deployment installs no key and no signer, so the review cannot carry
authority and nothing requires it:

- Authorization comes from the registered policy (`host.policy()`), the
  committed `passed` review/verify receipts, and the existing task, run, token,
  device, lease and STOP fences.
- The returned decision evidence records `verification.attestation: "advisory"`
  with no signature digest, key fingerprint or model judgment. Advisory grants
  use the host-owned issuer name `factory-host-policy` for ledger uniqueness;
  the credential id is only an idempotency key.
- Advisory mode may accompany `deploy_preview` only. `deploy_production` and
  `activate_skill` fail with `factoryPolicyAttestationRequired` until a trusted
  signer is installed.
- `merge` is denied in both modes. The application opens pull requests; a person
  merges, and repository protection is the enforced control.

A chunk written by an agent can never change an advisory decision: the verifier
does not read it, and a registered `deny` or `readOnly` policy still stops the
publication.

There is no production composition of this host yet. When one is added, it mints
the approval's `decisionCredentialId` server-side; the field is an idempotency
key, not a caller-supplied authority.

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

1. **Landed:** definition, strict validator, digest, CI check, tests. No
   production behavior changes.
2. **Landed:** `reviewKey` optional, advisory review, no merge, irreversible
   actions behind the strict attestation. Wiring the definition digest into the
   host follows when a production composition exists.
3. Per-agent secret allowlists and `credentialStrategy` execution.
4. Runner shapes, `workerHost` and hard budget caps for per-thread machines.

## Non-goals

- No in-application merge authority.
- No secret values in the definition or in prompts.
- No self-approved publication: an agent cannot approve its own work.
- No claim that a passing factory-config check proves provider acceptance.
