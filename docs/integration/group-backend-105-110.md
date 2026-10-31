# Group backend audit: #105 and #110

Both issue bodies and their empty comment lists were read on 2026-10-31.
Main baseline: `50def05730adc376f9b46f1374f2c886d9333dde`.

## Already in main

- #105's group tables, UUID messages, monotonic bigint timeline positions and
  group/member/message APIs were merged in PR #155. See the
  [migration](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/drizzle/20261023213851_group_conversations.sql#L8)
  and [group store](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/lib/group-conversations-store.ts#L31).
- Lists count unread messages by persisted read position and exclude the user's
  own messages. History checks active group membership and workspace access;
  membership changes and sends serialize on the conversation row. See
  [list/read visibility](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/lib/group-conversations-store.ts#L58).
- Mention routing, bounded serial rounds, durable group turns and live
  `agent_runs` status exist in
  [group-turns.ts](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/lib/coordinator/group-turns.ts#L22).
  Existing Coordinator and Bot chats retain their separate message/read paths.

## Confirmed #105 read-route defect and minimal fix

Main's `/api/conversations/:id/read` always delegates to `handleRead`, whose
`conversationOwner` accepts only `coordinator` and `bot:<id>`. A valid group
UUID therefore returns 404 even for its active members. Normal group readers
cannot advance `conversation_reads`, so list unread counts cannot clear.
Occurrence 10 × impact 4 = 40. See the
[main route](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/app/api/conversations/%5Bid%5D/read/route.ts#L8)
and [owner resolver](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/lib/conversation-reads-store.ts#L39).

The candidate dispatches UUID groups to the existing group authorization and
conversation lock, with forward-only read upserts and the same unread rule as
the list. UUID message IDs and persisted position strings both work. Personal
Coordinator/Bot paths remain unchanged; raw `agent_dm` IDs still return 404.
No schema, frontend, generator or group model redesign is included.

Real exported-route/PG checks: six pass, zero fail/skip. They cover normal
member reads, list count reduction, invalid/foreign messages, independent and
concurrent read positions, workspace-scoped callers, Origin, membership removal
and suspension. Replacing only the route with main's version reproduces the
404 path (four failures, two privacy checks pass). Existing Coordinator/Bot
read tests also pass 12/12 with a required real DB.

Environment: cloud Linux, isolated `mikka_policy_closeout_e2e` on localhost
55599, three matching database URLs, 155 applied migrations. Session lookup is
the only identity fixture; exported routes, application/workspace SQL and
authorization adapters are real. This is not a normal signup/full Next browser
acceptance. Logs: `/tmp/mikka-group105-{before,reads,existing-reads}.log`.

## #110 is not backend-complete

The [link table](https://github.com/alexj11324/Mikka/blob/50def05730adc376f9b46f1374f2c886d9333dde/drizzle/20261023213851_group_conversations.sql#L37)
and `agent_dm` kind are present, but main has no runtime link writer, no
`agent_exchange` timeline projection and no
`GET /api/conversation-links/:id/messages` route. Runtime source references to
`conversationLinks` are confined to schema declarations. Generic group history
deliberately accepts only `kind='group'`; that safe denial is not the requested
link-based read authorization. No implemented exchange marker can yet prove
the requested unread exclusion.

Backend still owns bounded linked-DM reads, source-group membership/workspace
visibility, sender metadata, link aggregation and timeline integration. The
existing table can support a separate bounded read API patch. UI Design / the
frontend owner owns the accepted marker and read-only panel, interaction and
visual acceptance; no frontend work was performed here.

#105 remains a parent issue: #110 and full authenticated group/turn/unread UI
acceptance remain outstanding. The current directory/runtime selects rows from
`agents`, whereas the current glossary defines chat Bots in `bots`; that product
binding also needs explicit integration/acceptance rather than silently treating
worker IDs as Bot IDs. Neither issue is closed by this scoped read-route fix.

## #110 bounded linked-DM read candidate

The next independent patch adds only
`GET /api/conversation-links/:id/messages?before=<position>&limit=<1..100>`.
It resolves the link's source group and reuses current group membership,
workspace/PAT scope and Origin checks. The target must be a same-workspace
`agent_dm` in the current group creator's legacy agent context. The API exposes
only the recorded `firstPosition..lastPosition` segment; arbitrary cursors cannot
widen it. Source-group membership grants this view without adding a user to
the private DM. Direct DM history remains denied.

Responses contain link/source IDs, recorded range/count, two participants,
bounded messages and `nextBefore`. Sender projection is limited to ID, public
name, harness and the existing nullable `avatarUrl` contract; worker instructions
and out-of-segment messages are never returned. Legacy `agents` have no stored
avatar image, so `avatarUrl` remains null rather than fabricating one. No UI,
new schema, model invocation, link producer or unread mutation is added.

The real exported-route/PG test now passes 7/7 with zero skips. Added coverage:
an ordinary group member reads a two-agent DM despite no direct membership;
both pagination pages contain only positions 2 and 3 from a five-message DM;
sender names are returned, private worker instructions are absent, and forged
cursors stay bounded. Unknown/foreign/kind-mismatched links, scoped callers,
removed group members and suspended workspace members are refused. The GET
leaves source read/unread state unchanged and has no POST export. Evidence:
`/tmp/mikka-group110-link-reads.log`, same isolated 155-migration database.

Remaining #110 work is explicit: real exchange creation/contiguous aggregation,
timeline `agent_exchange` projection and its pagination/unread behavior, actual
Bot/avatar binding and frontend read-only presentation with full system
acceptance. The bounded read API alone does not complete #110 or parent #105.

## #110 existing-link timeline projection (night follow-up)

Baseline `59ae2c2f`, with both issue bodies and empty comment lists rechecked on
2026-10-31. An existing authorized link was readable by its dedicated API but
absent from group history: occurrence 10 × impact 3 = 30. Group history now
returns an additive `timeline` alongside the unchanged `messages` and
`nextBefore`. Each source message has `type: 'message'`; its existing links
follow it as `{ type: 'agent_exchange', linkId, anchorPosition, count,
participants }`. Positions and counts remain exact decimal strings. A link
travels with its source message's page, so an exclusive source cursor cannot
repeat it on the next page. Markers allocate no message position and do not
affect persisted reads, unread counts or last-message previews.

Projection reuses the source group's current member/workspace/PAT checks and
includes only same-workspace, same-creator `agent_dm` links with exactly two
current creator-owned agent participants. It returns public sender metadata,
never DM bodies, instructions or the private conversation ID. The existing
link API remains the only bounded-message view; raw DM history stays denied.

The exported-route/real PG17 test passes 7/7 with zero skips against this
agent's retained isolated `scope184_ca4f5c0154df48d6ba451ba6882b1103_e2e` database
on loopback port 55599, with three matching database URLs. It checks the
one-message boundary page, following page, marker shape, foreign/kind-denied
links, read/unread stability and current caller authorization. Next's real
request/after context is drained; only session lookup is an identity fixture.
Log: `/tmp/mikka-group110-night-timeline.log`. No model/provider calls,
application signup/browser acceptance, new database or schema were used.
`pnpm typecheck`, focused oxlint and `git diff --check` pass. `pnpm test:groups`
passes its seven source tests; its separate Actions-only migration test stays
skipped locally, with its isolation guard preserved.

That projection-only revision was **not an exchange producer**. Runtime had no `agent_dm` creation
or `conversation_links` writer. `groupRuntime.generate` only created public
group replies and mentions; the private mailbox's trusted records identify
owner/workspace and run/Coordinator/Bot sessions, without a source group,
anchor message or authorized DM binding. Automatically sharing those messages
would invent provenance and expose private correspondence. Producer and
contiguous aggregation therefore remained skipped at that revision pending a trusted
group-originated exchange event. The Bot-versus-legacy-Agent identity binding,
stored avatars and frontend marker/panel also remain outside this patch;
neither #110 nor parent #105 is complete.

## #110 trusted group-turn producer

The next slice, based on main `e5261087`, connects exchange creation to the
existing real `processGroupTurn` host. Missing producer wiring was an ordinary
required path (occurrence 10 × impact 3 = 30), not an untestable provider edge.
The structured group response now chooses either a public reply (`privateTo:
null`) or one currently eligible peer. The model cannot supply a source group,
anchor, sender, link or private conversation binding. Those come from the
authorized queued root and the executing host agent.

The host rechecks workspace/actor and both current source-group peers under
the existing group row lock before committing each private message. It creates
an `agent_dm` containing exactly the two legacy agent members, appends one
`conversation_links` range for the source user message and extends that range
for consecutive messages. A later root reuses the same pair's group-bound DM
but allocates a new bounded segment. Each message and its position/link updates commit
together. This uses the existing tables and turn lock; no migration, extra
scheduler, provider, credentials or default-off gate was introduced.

Peer replies run serially, at most three messages per exchange, within the
existing turn deadline and hosted-model billing scope. Their transcript is
not added to public round context, routing corrections, source message
positions, last-message previews or unread counts. Private continuation is
restricted to the two peers, even if a response asks to address another
current group member. Failure retains an honest partial segment and the
existing failed/not-automatically-replayed turn state. No unrelated personal
mailbox/session history is read or retroactively shared.

Verification used the retained isolated PG17 database
`scope184_ca4f5c0154df48d6ba451ba6882b1103_e2e` at loopback port 55599 and
matching application/workspace database URLs. The actual group store and
`processGroupTurn` write the exchanges; exported history/link/read routes and
real ownership/workspace checks read them back. Only session identity and
model choice/text are fixtures. The route suite passes 8/8 with zero skips,
including continuous aggregation, a later separately bounded range, ordinary
source-member access, raw-DM denial, forged model/request bindings, unchanged
source unread positions, peer removal during generation and owner suspension
before persistence. Logs: `/tmp/mikka-group110-producer-db-final.log`.

`test:group-turns` passes 11 source tests plus two model-consumer tests; its
existing Actions-only database case stays locally skipped without changing
that guard. The actual AI SDK structured-output consumer also verifies required nullable
`privateTo`, its peer descriptor and UUID validation using a synthetic model.
New serial tests verify private-context separation, the three
message cap and foreign/self/third-peer refusal. Typecheck and focused lint
pass. No local Next build, new database/container, real model inference,
OAuth flow or external SaaS write was performed or claimed.

That producer revision still accepted only legacy Agent members. The next
section completes explicit Bot membership and public identity data without
turning Bots into coding agents or borrowing their private chat sessions.


## Explicit Bot members and private exchange identities

Based on main `3e2135e3`, the remaining normal path was concrete: passing a real
Bot ID as a Bot group member failed the old user/agent-only parser; sender and
participant readers queried only `agents`. Occurrence 10 × impact 4 = 40.
The backend now supports explicit `memberType: bot` and `authorType: bot`,
with a separate nullable `leadBotId`. It retains legacy Agent compatibility,
but never guesses a global alias from an internal coding-runner identity.

Migration `20261031153511_group_bot_members.sql` widens the existing two type
constraints and adds `conversations.leadBotId`, `group_turns.botId` and a
non-secret `group_turns.modelSelections` object. No existing history, creator,
member, read position or link is rewritten. An owner explicitly selects a lead;
choosing one type clears the other type, and removing that lead clears it.

The earlier isolated PG evidence used the original unmerged filename
`20261031132700_group_bot_members.sql`. Its SQL is byte-for-byte unchanged;
the premerge rename keeps this migration later than intervening main migrations.
Those retained databases and their original migration ledgers are preserved.

Production directory and runtime queries require the real Bot's creator-owner
and exact source workspace. Another workspace's Bot, or another person's Bot
in the same workspace, is rejected; ordinary source members may address the
creator's explicitly included Bots without becoming the billing identity.
The source creator remains the authenticated model owner, and both creator and
requesting member must still be authorized when execution proceeds.

`GET /api/conversations/:id/members` now supplies public user/Agent/Bot roster
data. Bot participants in source timeline markers and bounded private-message
views return the actual Bot ID, name, color and shape from `bots`, alongside
`memberType: bot`; private instructions, memory, bindings and credentials are
not exposed. Each DM member and message author retains its actual Bot or
legacy Agent type. A source member can inspect only the linked range, while
raw DM history remains denied. The same host-bound producer handles both
identity types and continues to exclude private text from public context and
unread counts.

Bot group generation reuses `freezeBotModel` and `resolveFrozenHostedModel`.
The first choice per Bot/root is persisted before invocation as the existing
safe runtime/model/subscription reference fields; later public/private replies
reuse it, and existing resolver checks run again on each call. No bearer or
private provider state is stored in that object or sent as group prompt data.
Missing bindings/refusals never switch a Bot to the legacy Coordinator's paid
model. Bot transport uses the existing streaming adapter and structured output.
The already-held group connection is reused for the composed model/settings
queries, preserving the existing application-pool boundary.

Running Bots use `group_turns.botId` and are exposed in group status plus the
existing owner-filtered active-status API as `kind: bot`, real public appearance,
and null coding run/task IDs. No synthetic `agents` or `agent_runs` rows and no
private Coordinator session leases are created for a Bot chat response.
Activity is bounded by the existing 20-second generation and a 60-second recent
status window; PAT workspace scope is retained for these new Bot entries.

### Verification and remaining frontend work

Real PG17 and exported application routes pass 9/9 with no skips on the existing
validated `scope184_ca4f5c0154df48d6ba451ba6882b1103_e2e` loopback target at
55599. No new database/container was created and the older frozen native
acceptance service/database was untouched. Only this isolated fixture database
received the tracked additive migration when its new columns were absent.
Session identity, model text/choice and binding-preparation results are explicit
fixtures; the group store, Bot directory/runtime SQL, private producer, status,
roster, history/link readers and workspace authorization adapters are real.

The actual API cases cover foreign-owner/cross-workspace Bot denial, source
membership, designated Bot routing, current names/colors/shapes, private-range
readback, absence of coding-agent aliases, pending activity, owner/PAT isolation,
stale activity expiry, per-root frozen selection reuse, failed binding cleanup,
peer deletion during generation and source-member removal. The model-consumer
suite separately exercises real AI SDK structured streaming, saved reference
shape, binding refusal and rejection of extra credential-shaped snapshot data.
It does not establish live inference or external provider acceptance.

Evidence:

- `/tmp/mikka-group-bot-db-final.log`: PG/API 9/9, zero skips.
- `/tmp/mikka-group-bot-unit-final.log`: 11 source tests and 3 model consumers
  pass; the existing Actions-only group DB case remains locally skipped.
- `/tmp/mikka-group-bot-activity-source.log`: 8 source tests pass, original
  Actions-only DB case locally skipped; the new activity API is exercised by
  the required real PG/API suite above.
- `/tmp/mikka-group-bot-groups-source.log`: 7 source tests pass, original
  Actions-only migration case locally skipped with its guard unchanged.
- Typecheck, deny-warnings lint, migration checks and diff checks pass.

No local Next build, new IAM/resource, OAuth flow, live model call or SaaS write
was performed. The only frontend-file change widens an existing helper's type
union for the new wire author type; it changes no layout, copy, appearance or
runtime lookup. The CC-owned view still fetches legacy `listAgents` at
`components/workspace/group-chat-view.tsx:31`, resolves non-user names from that
old dataset at `:43`, and renders `messages` rather than `timeline` at `:58`.
Actual Bot names/appearance and exchange ranges are now available from the
backend; connecting that view's roster, marker and read-only panel remains
frontend delivery, not missing backend identity/producer wiring.
