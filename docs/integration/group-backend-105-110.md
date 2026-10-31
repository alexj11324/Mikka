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
