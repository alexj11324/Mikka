# Active subscription checks omit unused quota

`authorizeRuntime` queried the complete stored quota JSON on every active
stream chunk and heartbeat. Only `model` / `native` admission uses that value.
Keep the same query, all authority predicates and check frequency, but return
SQL NULL for the unused quota field in other execution modes. Admission still
fetches the original quota and runs the same validator.

Production aggregate at 16:45:40 UTC: eight connected/refreshing/publication
pending records, quota mean277/max382/p95382 JSON bytes. These are connection
samples, not request-weighted; quota is not established as the overall bill's
main source. Risk: occurrence3 × impact2 =6.

Real isolated PostgreSQL regression, with a deliberately large synthetic quota:

| Check | Original protocol response bytes | Fixed |
| --- | ---: | ---: |
| active | 139,501 | 97 |
| native_active | 139,507 | 102 |
| model admission | 139,501 | 139,502 |
| native admission | 139,507 | 139,507 |

The original implementation fails the active-read assertion. Fixed tests also
confirm exhausted quota still rejects admission, active checks retain their
existing quota semantics, and paused connections stop streaming. Synthetic
sizes prove the projection, not a production or provider-billing percentage.

Full Go race suite81 top-level tests, go vet, three production/fixture binary
builds, CLI version, four real isolated PostgreSQL/API acceptance tests and
repository lint/typecheck passed. No production rows/statistics were written.
