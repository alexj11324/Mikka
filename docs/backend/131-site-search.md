# #131 independent title read contract

Base: main 2203c2c. The current GlobalSearch filters supplied recent arrays;
this candidate supplies reads for a later frontend integration. Latest main 05ca9d4
adds avatar changes, including lib/auth.ts; this independent branch does not overwrite
them. No layout changes.
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

For tasks, workspaceId selects the sharing context and requires the caller to be
active there. It does **not** make the task source strict-workspace-only. Auth's
existing owner predicate still returns the caller's personal tasks and owned tasks
linked to other workspaces (including ones where the caller is not a member).
Nonowners continue to require Auth's active membership and workspace-scoped link.
Consumers must not label every task result as belonging to the selected workspace.

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
workspace. The order is initial authorization + ACL-before-limit query, session
recheck, then a final visibility gate before serializing the response. For history
and groups the final gate rechecks every selected ID, including the lookahead row;
groups also recheck active workspace membership. Any loss rejects the **entire**
page with 403 searchAccessDenied, without items or nextCursor. It never removes
rows after limit or returns an old cursor revealing a now-hidden lookahead. Retry
with the same input/cursor to obtain a fresh authorized page. An empty successful
page is possible when the initial query already sees the revocation.

Tasks run the existing searchIssues query again for their final authorized page;
this preserves Auth's owner-visible predicate, title/number semantics, ACL-before-
limit ordering and has-more handling. There is no second task-policy implementation.
Auth #291 fbc181385e234469041451b1fb7992fcaffaf565 was read-only checked: its
issueVisibility helper still avoids request/global caching and retains this policy.

These are fresh statement-level checks, not a single cross-store snapshot.
Workspace, group/owner and auth checks occur in separate statements and databases;
a commit after the corresponding last check can race the response. No atomic
cross-database revocation or lock-through-network-send guarantee is claimed.

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

Input units cover limits and bound microsecond cursors. They are registered in
`package.json`'s existing `test:integrations`, already invoked by pnpm check and
normal source CI, and also by the dedicated workflow. This is one appended test
path; preserve Auth/R0's other package scripts when composing. No R0 runner,
recipe, migration, schema or permission helper is changed.

The dedicated workflow now starts **two PG17 service containers**: application on
loopback 5432/mikka_e2e and workspace on 5433/mikka_workspace_e2e. It bootstraps
each from the existing fixture helper. The HTTP profile refuses a single-service
configuration in this workflow, verifies database identities and opposite-store
absence, and puts membership/team rows only in workspace PG and tasks/history/
groups only in application PG. Existing generic browser jobs can run this file
in their usual single-DB fixture mode; those runs are not dual-PG proof.

`tests/e2e/site-search.spec.ts` starts a separate built Next process and a loopback
PG transport proxy. The proxy forwards real protocol frames unchanged; for the
race it delays an already-computed id/title/timestamp result until a synthetic
membership update commits. Real SQL therefore saw an allowed page **before** exit;
the final gate must reject 403 after delivery resumes. Both page-item exit and
lookahead-only exit are tested; retries return just the remaining authorized row
and no nextCursor. No query result, ACL or auth implementation is stubbed. Tests
also cover 130 history/125 group pagination, exact projections, foreign owners/
workspaces/private DMs, literal wildcards, body exclusion, task owner-wide policy,
workspace suspension and a token revoked during a blocked real title SELECT.

This is a dedicated post-build Playwright API profile, not a pre-build R0 recipe.
Fixture source rows and database identities are retained in a new report artifact,
without tokens/cookies; no fixture DELETE or schema DROP is performed. Normal
allowed run logs record the dual-store placement and each race outcome. Previously
Blob-denied artifact 12657970544 is not retried or used as this revision's proof.

No deployed Preview/production, real-user, performance or frontend acceptance is
claimed. Parent owns Auth composition, frontend wiring and fixed-version actual
acceptance. Keep draft; CI/PR success alone does not complete #131.
