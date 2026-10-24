# CPA OAuth transport review — 2026-10-24

The previous source slice allowed arbitrary configured HTTPS redirect URIs with
CPA's native public clients. A passing generic callback mock did not establish a
usable provider flow. This revision removes that assumption. Live flags remain
off and no provider grant, token import, secret write or inference was performed.

## Source evidence and resulting transport

CPA is pinned to [8289ec4](https://github.com/router-for-me/CLIProxyAPI/tree/8289ec4c71ad914d0612c2776352b76ba3d355a6), MIT. Comma was inspected at
[ddcdcc5](https://github.com/AFK-surf/Comma/tree/ddcdcc5bd49620cefa623da2f38b98e72a7b613e), AGPL, for comparison; no Comma code is copied.

| Route | Actual source protocol | Implemented Mikka transport |
| --- | --- | --- |
| Codex acquisition | CPA sdk/auth/codex_device.go posts client_id to auth.openai.com/api/accounts/deviceauth/usercode; polls /deviceauth/token with device_auth_id + user_code; 403/404 mean pending; successful response includes authorization_code, code_verifier, code_challenge; exchange redirect is https://auth.openai.com/deviceauth/callback | Narrow split-phase ordinary HTTP adapter follows those exact shapes, reuses CPA client constant and actual token exchange/Storage. Only fixed official verification URL + user code + opaque attempt handle reach browser. No client callback listener or invented registration |
| Claude acquisition | CPA internal/auth/claude/anthropic_auth.go uses claude.ai/oauth/authorize, S256 and http://localhost:54545/callback. sdk/auth/claude.go supports manually returning a callback URL and checks its state. Comma's embedded-sdk.patch also keeps the provider redirect | Exact registered loopback redirect retained. User pastes complete returned URL into Mikka's authenticated form, never assistant chat. Exact origin/path, one code and matching state, original session/owner, PKCE, expiry and one-use are mandatory. No local listener, local auth file or Keychain access |

Comma's account-proxy patch splits OAuth begin/exchange but does not establish
arbitrary web redirects. Its native-runtime Claude validation references a
provider-owned code callback; that separate interface is not registration proof
for pinned CPA's client. Mikka does not switch to it speculatively. A smoother
Claude callback UX requires separately verified provider interface compatibility.

Public-client protocol reuse is source compatibility evidence, not proof that
OpenAI or Anthropic accepts this hosted application, credential custody or honest
Mikka HTTP identity. No native identity/fingerprint spoofing, role replay or limit
bypass is added if a live route is refused. SIWC remains a separate capability.

## Review findings resolved in source

- Removed configurable redirect overrides and unregistered HTTPS callback flow.
  The old GET callback returns 410, never consumes query credentials or redirects.
- Device polling is owner/session/connection/operation-bound in Postgres. A
  persisted claim precedes the request; concurrent or early polls are refused.
  Pending responses release the claim with a server-side next-poll time. Provider
  interval is enforced with a five-second minimum, 15-minute authorization TTL.
- An abandoned or uncertain poll is not retried automatically. The claim remains
  fenced; reconnect creates a new epoch. Terminal protocol/store failures require
  reconnect or existing publication recovery as appropriate. Provider 429/5xx do
  not trigger retries, another account or paid fallback.
- Successful device response must have matching S256 verifier/challenge. The
  attempt is consumed before exchange, and current operation is checked again
  immediately before exchange. Reconnect/disconnect fence late publication in
  the existing Store. An already transmitted request cannot be undone.
- Claude handoff rejects foreign URLs, alternate ports, encoded paths, userinfo,
  fragments, duplicate/extra query keys, missing state, state override, raw codes,
  wrong session, expiry and replay. It never opens or fetches the pasted URL.
- Existing refresh publication serializes with Postgres operation claims and
  immutable Infisical versions, without assuming Infisical CAS. Existing tests
  exercise refresh races, store failure recovery and late reconnect/disconnect.
- Native access leases carry no refresh grant. Existing fake CLI tests exercise
  owner/account checks, isolated environment/home, revocation and Claude expiry
  stop. This is separate from acquiring platform credentials from local CLI auth;
  the latter has no route and remains forbidden.
- The Claude native adapter delivers its short-lived access lease through the
  CLI's OAuth environment interface. A fake CLI proves delivery and redaction,
  not whether real Claude shell tools scrub that environment. This is not a
  credential-hiding boundary against same-UID shell/process inspection. Before
  native activation, validate actual tool exposure and the owner runtime boundary;
  an external header broker (if native-compatible) is a separate option, not an
  implemented guarantee. Refresh grants and Infisical/E2B platform keys remain
  outside the native environment.
- Upstream diagnostic logging is disabled at the private executable boundary,
  because upstream errors can contain response bodies. Mikka emits fixed errors;
  secret values and ceremony inputs are not request log fields. Deployment body
  logging/redaction still needs acceptance before enabling the feature.

## Linux acceptance

Current evidence: /tmp/mikka-byos-oauth-review-acceptance.log; new tests exercise
actual production adapters against TLS fakes and real disposable Postgres. The
actual Settings component in Chromium covers Codex pending/complete and Claude
registered callback URL handoff, persistence and disconnect. No test substitutes
an invented Mikka HTTPS callback. Screenshot:
/tmp/mikka-byos-oauth-review-browser.png (synthetic state only).

Final checks on this revision passed: 19 worker top-level tests + 6 provider
subtests with race/vet/static build, the actual application/browser scenario,
30 migrations and replay, root/daemon type checks, 37 native subscription tests,
8 model tests, 11 migration policy tests, 13 i18n tests, catalog checks, code/UI
lint and a fresh Next production build. Build output contains expected BetterAuth
missing-key warnings in the secret-free isolated build; no real auth was tested.
Logs: /tmp/mikka-byos-oauth-review-{acceptance-final,types,daemon-types,native,
model,migration-policy,i18n,lint,ui-lint,build}.log. All owned test/build containers
were removed. The pnpm wrapper initially attempted an unavailable home-directory
install; direct installed tool executables completed the checks without install.
The full root aggregate was not rerun; prior unchanged baseline UI assertions
remain documented in byos-integration.md. Older phase-three acceptance is historical and does not
prove this revised transport.

## E2B: separate bounded next step, not provisioned

Compute, credentials and harness remain separate axes. Mikka's own harness may
invoke E2B terminal/browser/CUA tools from outside the sandbox; native Codex/Claude
Code need a runner inside an owner boundary. Bot desktops/sessions remain distinct
while project files can be shared. Same UID + different config directories is not
a credential security boundary.

Two topology options still need cost/security review: a verified owner-isolated
machine/runtime with shared project mounts, or a workspace machine with separately
verified owner isolation. A single unprotected shared HOME is excluded. No new
per-owner sandbox fleet is silently selected.

The next implementation step is an E2B transport for the existing private broker
and runner, with mocked create/connect/pause/resume/kill and per-bot desktop/tool
routing. E2B_API_KEY is read on the control plane only; never sandbox/model/agent
env. No real credential is needed to test that transport or topology attestation.

Before a separately authorized real lifecycle validation: propose exactly one
2-vCPU/4-GiB sandbox, one create, one harmless file sentinel, one pause, one resume,
one sentinel read, and one kill in a finally block, no retries; at most 600 total
running seconds, 300 seconds per running phase. Earlier budget estimate is
$0.0276 compute, with a proposed $0.05 maximum budget. This is a planning estimate,
not a verified current tariff or a provider-enforced spend cap. Recheck selected
template pricing and cleanup semantics before asking for the exact authorization;
if the bound cannot be enforced, stop. No sandbox, grant or paid call is authorized
by this document.

Live Mikka acceptance still requires separately authorized staging deployment,
provider authorization and dedicated Infisical bundle persistence, followed by
subscription-only inference with API-credit/extra-usage fallback confirmed off.
Native acceptance also requires pinned real CLI compatibility and verified E2B
isolation. Historical secret GC, provider-side revocation and workload-token
renewal remain release work; logical disconnect immediately fences Mikka use.
