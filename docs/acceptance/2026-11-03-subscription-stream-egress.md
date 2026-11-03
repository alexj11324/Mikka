# Subscription stream redundant database reads

Production's all-query counter comparison at 15:45:21–15:45:54 UTC observed
107 credential-record lookups and 101 binding checks. These queries belong to
the Go subscription worker, outside the Node query sampler. Subsequent three
complete observation intervals did not repeat this streaming burst, so this
does not establish its share of the entire provider bill.

`Stream` rechecks live authority on every provider chunk and every one-second
heartbeat. `activeRuntime` previously ran the binding check, then retrieved a
nineteen-column credential record whose return value both callers discarded.
Remove that unused lookup, preserving the explicit scope validation and every
existing authorization check at the same frequency. No credential cache,
revocation grace period or cross-worker credential sharing is introduced.
Risk score: occurrence 3 × impact 3 = 9.

Real isolated PostgreSQL regression test with pgx tracing:

| Twenty independently authorized checks | Queries | Socket response bytes |
| --- | ---: | ---: |
| Original redundant lookup restored | 40 | 15,844 |
| Fixed | 20 | 5,711 |

The original behavior fails the query-count assertion. The fix passes that
assertion and immediately rejects paused/disconnected connections, changed
epochs, wrong owners/workspaces/providers, deleted bindings/connections and
malformed scopes. Socket bytes are local PostgreSQL protocol measurements,
not Neon provider billing; the reduction applies to this specific check path.

Repository lint/typecheck and the focused real-PostgreSQL test passed. The full
Go suite, race detector, production worker builds and CI are tracked in the PR.
A separate agent reviewed the diff's scope/state/revocation behavior without
changing the patch. No production rows or query statistics were modified by
these tests.
