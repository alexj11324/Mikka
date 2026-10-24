# BYOS real-provider acceptance proposal

Source inspected at `9dba8b0a9de80f5221ce6f69ebdd62a23d4db6ab`.
This is a proposal, not authorization or a record of live success. No provider
request, OAuth grant, secret read/write/delete, deployment or E2B operation was
performed to prepare it. Do not read/import existing native CLI or Keychain auth.

## Current integration boundary

| Layer | Source status | Acceptance status |
| --- | --- | --- |
| Mikka account session and workspace authorization | Actual subscription HTTP dependency uses Better Auth and workspace checks | Synthetic handler acceptance passed; frozen deployed origin/session not selected |
| Connect, poll/code handoff, status, binding, disconnect | `/api/subscriptions` uses the actual service and private worker | Local real Postgres + fake HTTPS provider/vault passed; real provider/vault never run |
| Own harness | `/api/agent` resolves a persisted binding into the AI SDK adapter | Local app/stream tests passed; live subscription inference never run |
| Hosted native Codex/Claude Code | `launchNative` and daemon runner library seams exist | No production product caller; web runtime isolation is `none`; production worker refuses native token export |
| E2B tools/runner | Intended execution backend | Real transport and isolation not integrated/accepted; not part of the first live probe |

OAuth approval alone cannot close the last two source integration gaps. Do not
enable native export or claim that more credentials solve those gaps.

## Proposed first live probe: one new grant per provider

Use the user's selected ChatGPT/Codex subscription and selected Claude
subscription. The user signs into the official provider page in their browser;
their Mac may host that browser. Cloud Linux hosts the frozen Mikka candidate and
acceptance processes. No existing local CLI token is read or transferred.

| Provider | User ceremony | Scope evidence and explicit limitation |
| --- | --- | --- |
| OpenAI | Mikka Connect creates CPA-compatible device attempt; user visits the fixed `https://auth.openai.com/codex/device` page; Mikka polls and exchanges on its backend | Pinned device request submits only the CPA public client ID, not a caller-selected scope. Related pinned code-flow default is `openid email profile offline_access`; it does not prove the granted device scope. Inspect the actual consent description; stop if it grants unexpected capabilities or requires enabling paid usage. This is not an SIWC direct-use entitlement claim |
| Anthropic | Mikka Connect opens the fixed provider authorization page with S256/state and registered `http://localhost:54545/callback`; user returns the complete callback URL only through Mikka's authenticated handoff form | Pinned CPA requests exactly `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`. These include capabilities beyond the tiny inference probe and require explicit user approval; no claim of downscoping. The localhost return may display a connection error because no listener is installed; do not copy the URL into assistant chat |

The platform backend receives the new authorization result and exchanges it with
OpenAI/Anthropic. OAuth state/device secrets, full grant bundles and access-only
projections go to existing Mikka Infisical Cloud custody. Proposed dedicated
nonproduction paths are `/byos-acceptance/grants` and `/byos-acceptance/access`;
the actual project ID/environment/path must first be resolved from metadata and
approved. These are proposed names, not existing configured resources.

Online metadata update, 2026-10-24: the Mikka project is
`89850d6a-f020-4936-863e-df77380dfe40`, and staging exists. The current Universal
Auth identity `token` (`264e0674-6468-4731-a57d-7bb1957f735b`) has non-temporary
project admin membership and secrets read/create/edit/delete plus folder
permissions, with no environment/path conditions in its returned rules. This is
not the historical read-only `mikka-github-cloud` identity. It supplies existing
custody authority; no new writer identity is needed merely to gain write access.
The proposed BYOS paths and a distinct restricted execution reader remain
unverified. Do not pass the admin identity into the runtime. See
[the online metadata receipt](../infisical-cloud.md#current-cloud-agent-identity-online-metadata-2026-10-24)
for the exact successful queries and organization-details 403. No values, trial
writes/deletes or IAM changes were involved.

Infisical is controlled platform custody: authorized Mikka custody processes can
read full bundles; the inference process receives only the access-reader identity
and access projection. Provider requests necessarily use access tokens in the
trusted worker. Nothing is pasted into chat, model input, CLI arguments, browser
storage or logs. The only browser secret handoff is the short-lived Claude
authorization URL/code in the authenticated form; it is not a provider token.
Postgres stores owner/binding/status/digests/secret references, not token values.

Before a grant, verify the exact Infisical policies with synthetic sentinel
values: custody read/create/delete on both dedicated paths; execution read only
on the access path and denied on grants/write/delete. Permission-string inequality
in source is not an IAM test. This requires separate authority to configure/use
those workload identities. Do not inspect unrelated secret values.

## Bounded operations and pass criteria

1. Integrate the frozen candidate into the intended Mikka integration branch and
   combine-test any separately delivered credential backend. No combined result
   is currently claimed. Build one immutable nonproduction deployment with its
   matching existing nonproduction database and the additive migration. Do not
   promote an alias or modify production. Verify request/body logging is disabled
   for OAuth handoff and private worker frames before exposing Connect.
2. Use an actual Mikka session and workspace. Connect once per provider through
   the ceremony above. Confirm owner/provider/status metadata only; never display
   token values, complete callback URLs or private IPC frames in evidence.
3. Confirm API-credit/extra-usage fallback is disabled using the provider's actual
   controls and quota response. A model list alone is not evidence. If quota or
   billing mode is unknown/exhausted, stop before inference and record that refusal.
4. For each provider, run two tiny own-harness tasks using the same connection,
   at most 64 output tokens each, one provider request per task, no tools or user
   repository. Recreate the worker between tasks and prove no second login.
   Requests use the ordinary Mikka identity; a provider refusal is a failed route,
   not permission to imitate an official client or use another billing source.
5. Perform at most one explicit refresh per new test connection, with no refresh
   retries, to validate rotated artifact publication and subsequent reuse. This
   requires permission to rotate the newly created grant. Capture only metadata;
   do not modify native CLI credentials. An uncertain result is recovered/fenced,
   never replayed automatically. Two live model requests per provider remain the
   total budget: put the refresh between them.
6. Verify wrong task, stale binding and unauthenticated requests refuse before
   provider I/O. Cross-owner deployed acceptance additionally needs a second
   explicitly authorized Mikka test identity; it remains unrun without one.
7. Disconnect the two new test connections. Confirm logical refusal before further
   provider I/O and cleanup of only their registered test artifacts. Up to five
   artifacts per provider are expected for attempt + initial grant/access + one
   refreshed grant/access. Unknown late outcomes remain pending. Provider-side
   revocation is `not_implemented`; user may separately revoke the new grant in
   the official account UI. Do not claim vault deletion revokes upstream access.

The first probe excludes reconnect/new grants beyond the initial two, native CLI
launch, E2B, paid API keys, user projects, API credits and automatic retries. It
can establish the deployed own-harness path only. Hosted native acceptance still
requires an actual product dispatch, a verified owner/tool boundary, safe native
credential delivery and a transport before a separately approved real probe.

## Required authorization and cost boundary

- Exact frozen deployment origin/commit, existing nonproduction database and
  authority for its migration/deployment. A localhost-only test is not deployed
  Mikka acceptance. Current target metadata has not been resolved here.
- The two selected provider accounts, consent to the scopes/ceremonies above,
  and explicit permission for Mikka to retain and refresh only these new grants
  in the approved Infisical project/environment/paths for the acceptance window.
- Narrow workload identity/policy configuration, synthetic IAM probes, and
  create/read/delete of only this run's new BYOS artifacts. Existing secrets and
  existing native CLI auth remain excluded. Define retention/cleanup before login.
- At most four subscription model calls total, 256 output tokens total, two
  explicit refreshes total and the bounded OAuth polling interval/TTL in source.
  No new paid plan/resources or API-credit fallback is proposed. Existing
  Vercel/Infisical plan operation charges and provider billing controls are not
  verified; no numerical zero-cost guarantee is made. Confirm those charges or
  a separately approved spend limit before live work. E2B cost is excluded because
  this probe creates no sandbox.

All above live actions are pending authorization and configuration, not denied
or attempted. The native product dispatch/transport/isolation gaps are technical
work, not blockers that can be removed merely by approving OAuth consent.
