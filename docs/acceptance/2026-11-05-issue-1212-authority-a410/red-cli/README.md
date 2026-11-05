# Actual idle CLI deadline RED

Source: `a410b292cc53cfef43992a91d7696023e3481567`.
Environment: the assigned Vercel sandbox, Node 24.22.1, real isolated PostgreSQL 17.11. No production database, model, provider, account preference or Cloudflare mutation.

`red-4.log` is the first valid cancellation RED. `red-1.log` (missing fixture signing environment), `red-2.log` (copied fake CLI's relative module absent), and `red-3.log` (fixture incorrectly expected `stopOwnedRun` to end an admitted run synchronously) are retained setup failures, not cancellation evidence.

The final fixture uses the real device-authenticated HTTP claim, real signed policy distribution, real `AgentToolApprovalStore`/policy SQL, actual `HttpServerLink`/`ToolApprovalGate`, and actual `ClaudeAdapter` child process. Only the model CLI is the existing offline fixture, and HTTP response delivery is deliberately held after the actual authority route completed. The child has entered its silent mode before the fault. The test uses real `stopOwnedRun` and a separate pool query confirms its committed `stopRequestedAt`.

Observed run: `ec4cb19b-7474-42bf-835f-d27b3a455d24`.

| Observation | Actual result |
|---|---:|
| Stop transaction call duration | 2.051927 ms |
| Time observed after Stop returned | 1004.820888 ms |
| Gate revoked | No |
| Actual child exit observed | No |
| Child SIGTERM marker | Absent |
| HTTP authority requests before/through observation | 2 |
| Required bound | 1000 ms |
| Result | FAIL at the cancellation assertion |

`red-4.log` SHA-256: `c2774ddbe9a1fa844d582c5e1c58a2e94672a0739f7ff0313d56570858f281b7`.
`http-fixture.patch` SHA-256: `31cc5159f5e5b162256b6494d22166e130145364aedf62e6e773be7ff0d163fb`.

This is the new bounded-authority acceptance target. It does not relabel the existing legacy HTTP 5-second timeout / 30-second unreachable grace as an accidental regression; old-client behavior remains a compatibility requirement. The held HTTP response is a transport fault, not a simulated database result. The two observed HTTP requests are not a measured count of their underlying SQL statements.

The test always revokes its own gate, releases its held response, cancels and consumes its own child, and removes its own temporary directory. Its disposable database and raw failures are retained. No source-level liveness behavior has been changed to obtain this RED.

The next candidate is an explicitly supplied authority source with a monotonic challenge deadline; it must prove the same actual child cancellation before any production wiring or claim of A completion. Native broker and CPA stream coverage remains separate.
