# Task Secret delivery

Implementation owner: [#1712](https://github.com/alexj11324/Mikka/issues/1712).
Architecture authority: [credential exposure ADR](../design/decisions/2026-11-08-0240-credential-exposure-boundary.md).

## Source audit and migration

The audited baseline is `3c32675c99d32f9c84a9b5e4bc48e59231baa4d8`.
At that version, `loadTaskRuntimeSecrets()` decrypts the matching workspace and
repository rows, then the run owner's personal rows. Repository values override
workspace values; personal values override both. Reserved environment names are
filtered. `taskSecretInjection()` still puts every remaining `kind=secret` value
in `taskEnv`, and the cloud claim returns it to the task VM. The hosted runner
adds it to the native CLI's environment. A shell-capable Agent can read that
environment even when output is masked. This finding is source evidence; it is
not a claim that a production credential has been read or exposed in a report.

| Authority | Current storage / owner | Intended delivery |
| --- | --- | --- |
| Task GitHub credential | Existing GitHub connection / selected run principal | Native Git and gh credential, as before |
| Selected model authentication | Selected subscription or model-key store | Native official Claude Code / Codex credential, as before |
| Personal API Secret | `user_secrets`, authenticated user | Protected capability by default; explicit per-secret direct compatibility |
| Workspace / repository API Secret | `workspace_secrets`, existing scope and permissions | Same protected capability, with resolved scope frozen at admission |
| Non-sensitive configuration | Existing `kind=env` rows | Ordinary environment value |
| Connected apps / MCP | Existing server-side integration custody | Existing authorized operation; no second preflight |
| Saved browser credentials | Separate KMS browser credential broker | Existing browser broker; no new generic plaintext read |
| Platform database / Infisical / deployment credentials | Trusted platform configuration | Never part of task Secret delivery |

The new metadata belongs to each existing Secret row. This change does not
create another vault or introduce Project/Environment entities. It preserves
the current override order and leaves the Project/Environment model to #1687.
Existing protected entries without an HTTP policy need an explicit delivery
choice. They must be reported as unavailable, never automatically downgraded to
direct exposure. Ordinary `kind=env` entries retain their behavior. A person who
chooses direct mode accepts that the Agent and same-permission host processes
can read that value; masking does not change that fact.

## Protocol and trust boundary

Claim resolves owner, workspace, exact repository, run, device and claim
credential using the existing authorization path. A short-lived encrypted
capability carries only the resolved HTTP grants. The encryption key remains on
the trusted application service. Capability encryption has its own domain; it
must not accept a stored-row ciphertext as a grant or vice versa.

The third-party data-plane handler validates the capability and the requested
operation, injects authentication, and makes the authorized HTTPS request. It
does not read the control-plane database or call a remote authorization API.
The native model and GitHub paths do not call this handler. Any local SDK bridge
holds opaque capabilities only: it is a compatibility adapter, not the
confidentiality boundary. A local sidecar holding plaintext would not satisfy
this design.

HTTP policy pins the HTTPS origin, permitted method and exact path or bounded
path prefix, and authentication header. It rejects URL credentials, unsafe
ports, fragments, ambiguous paths, attacker-supplied authentication, redirects,
private/reserved addresses and DNS rebinding. The actual TLS connection must use
the address checked by the egress handler. Request and response sizes and time
are bounded. Error and trace output contains closed error codes, not URLs,
headers, capabilities or credential-bearing exception messages.

Capabilities expire no later than the current run lease (90 seconds). Renewal
uses the existing authenticated device heartbeat and only a successfully
renewed, matching claim; no new polling or provider/tool preflight is added.
Stopping or revoking a run prevents renewal. The running task's bridge closes
when its existing stop signal arrives. **A copied bearer capability can retain
its already granted authority until that short lease expires.** An in-flight
upstream effect cannot be recalled. The implementation and tests must expose
this bound instead of claiming instantaneous distributed revocation.

Changing or deleting a Secret or its delivery policy invalidates the affected
run authorization, so an old encrypted grant cannot renew indefinitely. A new
claim re-resolves current values and policy. A retry or a different device must
not inherit a previous claim's grant. Capabilities and direct-mode values stay
out of journals, reusable templates, checkpoints, artifacts and diagnostics.

## Compatibility and remaining authority

Compatible HTTP SDKs can target a per-secret loopback base URL using a dummy
SDK key; the trusted egress supplies the actual key. Ordinary fetch/curl calls
can use the same adapter. The adapter does not change `HTTP_PROXY`,
`HTTPS_PROXY`, provider base URLs, native CLI HOME, Git configuration or official
CLI files. SDKs that sign requests locally, use a non-HTTP protocol, pin the
provider URL, or otherwise require plaintext need a narrow existing server-side
tool, an appropriate short-lived upstream credential, or explicit direct mode.
There is no automatic fallback from protected mode.

The Agent can exercise the allowed API authority. Route restrictions cannot
prove that a third-party API has no dangerous operation or deliberately encoded
credential echo. The destination service and trusted server are inside the
credential trust boundary. Direct echoes are rejected as defense in depth; this
does not establish protection against an adversarial provider, a compromised
trusted server, or root access to that server. On a personal device, unrelated
same-user credentials already on that device are outside this delivery feature.

## Evidence required before completion

Use only generated canaries, an isolated database, and disposable test state
for leakage tests. Record the exact application and worker revision. Verify
scope precedence and negative owner/workspace/repository/run/device/attempt
cases; expiry, renewal refusal and rotation; origin, path, header, redirect and
DNS refusal; SDK/direct compatibility; subprocess environment and journal /
checkpoint absence; and successful authorized upstream use. A raw string mask
alone is not proof of confidentiality.

Measure admission separately from steady-state third-party request overhead.
Report sample count and p50/p95 on a fixed version and environment, with SQL and
additional authorization RPC counts. Do not combine #1505's historical cold
startup measurements with this experiment. Native model/GitHub paths must gain
zero per-call authorization RPCs. Production external-service acceptance still
requires the official Claude Code and Codex subscription paths, and the real
GitHub delivery flow; synthetic tests are not substitutes.

This document starts as a design and source audit. Passing evidence, workflow
links, version pins and remaining gaps are recorded on #1712 and its PR as the
implementation is verified. No production runtime protection is asserted by
this document alone.
