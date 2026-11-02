# Settings and execution usability review

This review follows Alex's request to inspect the repository's settings,
copy, entries and execution flows with domain modeling and Nielsen's ten
heuristics, and to fix demonstrated defects in parallel. It covers the
Mikka monorepo, not the separate marketing-site repository. It is source
review with targeted executable evidence, not a claim to have read every
line or exercised every production service and device.

## Domain rules

- Personal subscriptions and API keys remain usable by their owner across
  their workspaces without sharing. Sharing grants other members access;
  disabling sharing does not remove the owner's use. See
  [Alex's reaffirmation](../decisions/2026-11-02-1936-personal-credentials-without-sharing.md).
- Bot chat choice and Agent task preferences have separate owners and
  lifecycles. The ordered **优先使用的模型** and preferred Agent follow CC
  [PR #1053](https://github.com/alexj11324/Mikka/pull/1053).
- Connection, model-specific allowance, machine readiness, current execution
  and next-message choice are different states. Reading a stale or missing
  allowance cannot establish availability or authorize paid fallback.
- A run freezes an exact credential, provider model, Agent and destination.
  The credential lender and run owner remain distinct principals.

See [the scope and recovery specification](../subscription-execution-settings.md)
for the object table and task walkthrough.

## Coverage

| Surface | Inspected paths and boundaries | Evidence limits |
| --- | --- | --- |
| Model settings | Subscriptions, API keys, quota, sharing, default order, Agent and run location | Source, DOM, isolated PostgreSQL, production-build rendering |
| Bot chat | Menu resolution, frozen selection, paid fallback, failure notices and retry outcomes | Source, DOM, PostgreSQL and separate live provider checks |
| Agent execution | Resolution, queue, exact binding, local/cloud claim, native lease/request and model policy | PostgreSQL, real local runner with offline CLI fixture; live owned subscriptions separately |
| Devices | Participation, capability checks, desktop registration and repair identity | Actual installer/daemon-map async fixtures; no physical Mac or Electron session |
| Account/security | Profile/avatar, password/session boundaries and account lifecycle reads | Source and targeted avatar tests; no real password changes or deletions |
| Privacy | Shared links and failed/empty/stale reads; export boundary | DOM and source; no real export or public-link revocation |
| Billing/usage | Member payment states, role scope, run-chain counts and duration | DOM and PostgreSQL; no purchases or real card changes |
| Preferences | Web saves and mobile confirmed/pending states, memory and notifications | Deterministic failures and concurrency; no physical push delivery |
| Workspace/team | Navigation, membership, roles, secret scopes and departure boundaries | Source and existing role/authorization regressions; no real invitations or transfers |
| Connections/plugins | Native GitHub/Linear/Telegram reads, Composio state, recovery entries | DOM/async reads and source; no real OAuth or disconnect |
| Tasks/threads/groups | Entry and state projection, root-chain definitions, stop and continuation | Source and relevant PostgreSQL cases; no real repository push or group messages |
| Schedules/audit | Scope, cron/lease boundaries, cursors, exports and retention entry | Source and existing checks; no real scheduled external actions or retention run |
| Native mobile | Account/workspace cache, model menu, retries, outbox, paused-thread recovery and web handoff | Async/React tests, real auth and PostgreSQL boundaries; no physical iPhone |
| Shared protocol | Subscription, bridge/device identity and frozen execution contracts | Protocol, daemon and Go checks |

## Demonstrated problems and repairs

Occurrence and impact are 1–10 triage estimates, not measured production
rates. H1–H10 refer to Nielsen's heuristics. These rows track implementation;
the PR records the immutable revision and actual checks.

| ID | Trigger and repair | Heuristics | Occurrence × impact |
| --- | --- | --- | --- |
| S1 | A stale saved chat choice displayed one source while execution used another. Menu and freezing now share resolution and identify fallback. | H1, H3, H4 | 8×8 |
| S2 | Provider and binding failures became one generic notice. Finite safe reasons now drive matching recovery on web and mobile. | H1, H9 | 8×7 |
| S3 | Unknown or stale quota appeared available. A shared model-aware projection distinguishes available/checking/exhausted, with bounded active refresh. | H1, H4, H5 | 7×7 |
| S4 | Account resources and workspace defaults appeared to have one scope. The page groups them explicitly and uses the resolved workspace. | H2, H4, H6 | 7×7 |
| S5 | Same-plan accounts and same-model keys looked identical. The picker retains safe account/key/owner identity. | H2, H6 | 5×7 |
| S6 | An exhausted model-specific window disabled unrelated models. Authorization checks only applicable windows in TS and Go. | H2, H4, H5 | 4×8 |
| S7 | Historical bindings were called current use, with duplicate Coordinators. Cards project current chat choices in the named workspace. | H1, H4, H6 | 6×5 |
| S8 | Retry ignored queued:false or action errors. It now reports the actual result and prevents concurrent duplicate submission. | H1, H9 | 6×5 |
| S9 | Changing the composer model during generation appeared to change the active run. Both clients mark the next-message choice. | H1, H3 | 5×5 |
| J1 | A Bot's chat key overrode an explicitly selected Agent credential. Exact thread selection now survives local/cloud queueing. | H4, H5 | 6×9 |
| J2 | New-task placement independently defaulted to cloud and overwrote settings. It inherits the shared planner unless explicitly changed, and can return to defaults. | H2, H4 | 7×7 |
| J3 | Online devices appeared runnable without participation, Agent or broker support. The chooser uses the same ready-device projection as dispatch. | H1, H5 | 7×7 |
| J4 | Cloud startup failure claimed an E2B key was missing even when configured. Missing and temporarily unavailable remain distinct. | H1, H9 | 6×7 |
| J5 | Shared subscriptions reached chat but failed Agent candidates, binding or claim. The full path retains the lender and rechecks membership/sharing. | H4, H9 | 5×8 |
| J6 | Shared native execution applied model policy to the lender instead of the executor. Default policy admission now derives the run owner from the authorized leased run. | H4, H5 | 5×8 |
| J7 | Shared quota recovery called an owner-only usage endpoint. A server action authorizes and refreshes the selected shared connection. | H1, H9 | 4×4 |
| J8 | A selected shared subscription could become a paid own key even with fallback off. Capability lookup now uses the actual binding owner/connection/revision. | H1, H5 | 4×7 |
| J9 | Concurrent dispatches reused an Agent's mutable latest binding. Queueing now reauthorizes the exact binding ID; idempotency rejects changed credentials. | H4, H5 | 5×8 |
| J10 | Device model aliases disagreed with the native lease model and prevented CLI start. Subscription execution preserves the provider model through resolver, snapshot and CLI. | H4, H9 | 5×8 |
| J11 | Quota fallback could select a key's unrelated first model. It requires the same frozen model and compatible protocol, otherwise pauses. | H1, H3, H5 | 5×7 |
| O1 | Run attempts were counted as new threads. Usage counts canonical roots and still sums all run duration; parent lookup preserves visibility and scales by current-month seeds. | H1, H2, H4 | 7×4 |
| O2 | Large avatars cropped only their central 256 pixels. Source crop and output resolution are now separate. | H2, H5 | 8×3 |
| O3 | Member payment reads failed into blank content. Loading/error/retry are distinct from successfully inapplicable data. | H1, H9 | 4×5 |
| O4 | Failed shared-link reads claimed there were no links. Unknown state stays visible and last-known links remain manageable. | H1, H9 | Privacy-sensitive |
| O5 | Native app read failures became absent connections or a fake paused state. Per-source failure and retry retain last-known data. | H1, H4, H9 | 4×4 |
| M1 | Native quota-paused threads had no recovery entry. A card reuses the continuation endpoint; key charging requires explicit selection. | H1, H3, H9 | 6×8 |
| M2 | Failed preference saves could show memory disabled while the server kept it enabled. Confirmed values and pending intent are separate, serialized and retryable. | H1, H5, H9 | Privacy-sensitive |
| M3 | Mobile web handoff opened another workspace's Coordinator. Targets preserve the Bot/workspace and confirmation rechecks membership and ownership. | H2, H4, H9 | 5×8 |
| M4 | A lost mobile send response let retry enqueue the same instruction twice. Stable submission IDs reach the existing server ledger. | H1, H5, H9 | 4×8 |
| M5 | Desktop repair reported an old account's daemon as connected. The main process rechecks trusted session/device ownership and keys setup by account context. | H1, H2, H9 | 4×7 |
| M6 | A failed first model-menu read removed its own recovery entry. The chip retains loading, failure and retry. | H1, H6, H9 | 5×6 |
| M7 | An old account/workspace request could repopulate the new context's mobile cache. Identity/generation/request fences prevent late reads, writes and 401s crossing contexts. | H1, H4 | Privacy-sensitive |

The strongest evidence concerns H1, H2, H3, H4, H5, H6 and H9. Task-entry
and recovery discontinuities inform H7. This review does not manufacture a
finding for H8 or H10, nor establish accessibility compliance from screenshots.

## Boundaries and pending product work

- The proposed three-column **用途 / 模型 / Agent** list is a design proposal.
  Purpose-based routing and cross-provider native subscription compatibility
  are not introduced by these repairs. Compatible API-backed combinations
  must be validated separately; a subscription is not a universal API key.
- Alex asked for a simple credential model. The Infisical/Doppler comparison
  does not authorize a custom-role or environment-permission product. The
  existing member secret-management policy has conflicting documentation;
  this repair grants no new privilege and does not treat creation alone as
  the owner of a team secret.
- Multiple OAuth connections for one provider subject need one coherent
  logical-account lifecycle. Merely adding an alias anchor while pause and
  disconnect affect only one connection would be incomplete; no partial
  alias fix is included.
- Existing intentional platform limits, hidden unbuilt PAT/2FA surfaces and
  documented Linear synchronization policy are not classified as bugs.
- Live owned Claude/Codex acceptance, offline native fixtures, isolated
  database tests and production rendering prove different boundaries.
  They do not establish a deployed production chat, physical-device run or
  actual E2B execution. Those claims require their own recorded evidence.
