# #131 independent title read contract

Base: main 2203c2c. The current GlobalSearch filters supplied recent arrays;
this candidate supplies reads for a later frontend integration. No layout changes.
No Bot/harness tool registration, Agent generation/list product or knowledge store
is added. #131 remains open until coordinated integration and real acceptance.

`GET /mikka/api/search?source=history&q=keyword&limit=20`

| source | workspaceId | permission and matching | order |
| --- | --- | --- | --- |
| history | omitted (400 if supplied) | current owner of agent_sessions; title substring only | updatedAt DESC, id DESC |
| groups | required UUID | active workspace member AND current user group member (leftAt IS NULL); kind=group; title substring only | createdAt DESC, id DESC |
| tasks | required UUID | existing searchIssues policy and number/title query semantics, unchanged | existing updatedAt DESC, id DESC |

Each request returns a `SearchPage` from `lib/federated-search/types.ts`:
`{ source, items, nextCursor }`. `SearchItem` is a discriminated union (`type`:
`history`, `group`, `task`). The frontend can fetch these three pages concurrently,
render together, and continue each independently. A total ordering across sources
is not promised. Timestamps label the order field, not last-message time.
Historical archives have owner scope and no workspace relationship. Do not label
them workspace records. Opening any hit must use the destination's current ACL.

Empty q means recent. q is trimmed and capped at 200 UTF-16 units; one CJK
character is allowed, one other character is rejected, as in existing task search.
History/group numeric queries are literal titles. `%`, `_` and backslash are
escaped. Default page size 20, maximum 50; fetch limit+1 only after ACL filtering.
No total counts or hidden-result scan cap. Opaque continuation keeps PG microseconds
and UUID tie-breaking, and binds the user/source/workspace/query. Changing page
size is allowed. It is a seek cursor, not a snapshot: edits changing the order key
can move rows during pagination. Forging a seek key never grants visibility.

All responses/errors: private, no-store. Session cookie cache and refresh are
disabled for reads; auth is rechecked before returning. Workspace selection uses
read-only membership queries, never the context helper that creates/renames a
workspace. Membership is checked on each request and again after workspace reads;
group membership and owner predicates are evaluated in SQL before limit. Revoked
members cannot continue using an old cursor. App and workspace DBs remain separate;
there is no distributed snapshot/atomic revocation guarantee for a revoke racing
an already authorized query. Task policy remains owned by Auth #291.

401 authRequired; 400 invalid query/cursor/selectors; 403 searchAccessDenied for
both inaccessible and nonexistent workspaces; 422 searchSourceUnsupported for
agents/knowledge (product definition / source and ACL required); 500 generic
searchFailed, without logging queries or database error values. Unknown sources
are invalid. Unsupported sources never return an empty successful page.

Only explicit title projections are selected. No prompts, completions, message
bodies, agent configuration/instructions, run logs, Coordinator memory, private
agent_dm or linked private exchanges are searched/returned. Search does not
change application data or call external providers. No migrations, index additions,
credentials or new services. Large title-substring performance on production
has not been established; existing owner/member indexes still bound visibility.

## Verification and owner handoff

Input units cover limits and bound microsecond cursors. `tests/e2e/site-search.spec.ts`
runs actual built Next HTTP + Better Auth against isolated PG17. It retains
synthetic fixtures, covers 130 history/125 group results, foreign owners/workspaces,
private DMs/nonmembers, literal wildcard matching, body exclusion, exact result
allowlists, task reuse, session revocation during a blocked real title SELECT, group exit and workspace suspension.
The dedicated `site-search.yml` executes this profile, types and lint. This is a
post-build Playwright API profile, not a stubbed handler or pre-build R0 recipe;
it does not edit the R0 inventory/schema/permission helpers.

No deployed Preview/production, real-user, performance or frontend acceptance is
claimed. Parent owns Auth composition, frontend wiring and fixed-version actual
acceptance. Keep draft; CI/PR success alone does not complete #131.
