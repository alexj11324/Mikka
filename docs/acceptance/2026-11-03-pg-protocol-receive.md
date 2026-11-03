# Connection-level PostgreSQL receive measurement

The existing 1% row-JSON sample cannot measure column descriptions, command/error messages and other PostgreSQL protocol traffic. Supplier egress remains unexplained; this change supplies evidence, not an asserted traffic reduction.

`db_transport_sample` reads each connected Node pg stream's cumulative `bytesRead`, once per runtime window (60 seconds) and at connection removal/close. Queued and overlapping queries do not get separate byte deltas. Default/request and authority-fence pools use the same collector. It never reads payloads or SQL/parameters, changes socket flow, or changes authority/transaction behavior. The existing `dbEgressSample` PostHog gate controls emission. Acquisition detects a gate loaded after connection creation, baselining there to exclude off-period data. Timers are unref'ed and stop when no tracked connections remain.

These are **received plaintext PostgreSQL protocol bytes from observed Node connections**, not HTTP bytes, estimated JSON, encrypted TLS bytes, or supplier metered bytes. Startup before registration is excluded. Go worker connections, other runtime instances and uninstrumented clients are outside a record's scope. Missing/reset/unavailable counters emit `coverage=incomplete` and `pgProtocolReceiveBytes=null`; the known partial contribution remains separate. Connection-close windows can be shorter than a minute. Runtime termination before final logging can lose a window; absent logs are never zero usage.

## Validation

- Three collector tests cover duplicate registration/acquisition, consecutive windows, remove+close idempotence, gate off→on→off→on exclusion, and unavailable/decreasing counters.
- Twelve related collector/JSON-sampling/request-scope/device error tests passed; all 73 library unit tests, root typecheck and root oxlint passed. All five real isolated device-unit-fence tests passed, including revocation ordering, idle burst release, hung-fence refusal, pool exhaustion and concurrent requests; the same five tests also passed with the egress gate enabled through the test-only switch override.
- Real isolated PostgreSQL `mikka_transport_e2e` on loopback: 80 queued synthetic SELECTs on two connections (alternating a boolean and a 22-column empty result), one database identity read and one error response produced **36,831 PG protocol bytes**, versus **600 row-JSON bytes** for the 80 synthetic results. The measured aggregate equalled both socket-counter deltas exactly and did not change after remove/close settlement. No production records or message contents were used.
- Red/green: deliberately disabling counter accumulation makes the real database exact-byte assertion fail; restoring it passes. The real PG test is included in existing `test:ops-db` CI suites; unit tests are in `test:lib-units`.
- This synthetic example demonstrates a blind spot; it does not establish the production overhead share or explain the supplier's full hourly traffic.

## Driver and billing references

Node24's `TLSSocket.bytesRead` was additionally checked with a local synthetic TLS peer: completed handshake had zero plaintext bytes while the raw TCP socket had received 2,425 bytes; subsequent application responses incremented TLSSocket bytes by exactly their plaintext lengths. Production code does not use the private parent socket.

Public Neon proxy source at immutable revision `fa504217c61bbcaf5c512d75830564541f917f8f` wraps the client side with a measured stream in [passthrough.rs](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/pglb/passthrough.rs#L27-L41), whose TLS stream delegates decrypted reads/writes in [stream.rs](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/stream.rs#L314-L338). SQL-over-HTTP instead records serialized JSON length and explicitly excludes headers/TLS overhead in [sql_over_http.rs](https://github.com/neondatabase/neon/blob/fa504217c61bbcaf5c512d75830564541f917f8f/proxy/src/serverless/sql_over_http.rs#L590-L606). This public revision has not been established as the production supplier revision, and application counters do not prove complete project billing coverage.

Runtime commit: `154d813f`. Database validation used only the dedicated loopback `mikka_transport_e2e` database, migrated from tracked migrations. No UI changed, so screenshot acceptance does not apply. Full `pnpm check` is running separately; its result must be recorded before claiming it passed.
