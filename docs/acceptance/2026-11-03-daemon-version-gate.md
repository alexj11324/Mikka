# Daemon version admission

Branch: codex/daemon-required-version, base b0553336.

A daemon whose update failed could obtain a new login credential and continue
ordinary API polling: the minimum version was checked only when claiming work.
Occurrence10/10, impact4/10, score40; the old released version was observed on a
live backend. The minimum now names the already published fixed release0.0.375.
The shared device-route wrapper checks authentication first, then release
admission; registration separately checks its body version.

A revoked old credential receives401 even when its binary reports the new
version. A fresh credential with an old or missing version receives426 before
business operations. A current header cannot disguise an old registration
body. Current/source clients and scoped cloud workers remain compatible.

Upgrade control (heartbeat and command polling/ack) remains available only with
valid authentication. An original claim credential with a current live lease
may finish its existing work; a new login cannot borrow that grace. Existing
claim checks still refuse new work below the floor. No token is revoked by
this patch and no production data is changed by its tests.

The regression was verified against the implementation without the wrapper
check: the fresh-old-client request returned200 rather than426. With the fix,
7 real PostgreSQL enrollment/management tests pass, including fresh-login old
binary, old revoked login with new binary, and registration-header/body mismatch.
Source/platform unit checks, typecheck and full lint passed. Fifteen real
PostgreSQL revocation, heartbeat and unit-fence tests passed. The actual npm
0.0.375 HTTP client passed its compatibility contract against current device
routes and a migrated, separate local PostgreSQL database. The PR records
Git-linked CI for its final revision.

The active released-client compatibility fixture is fetched from the public
npm0.0.375 tarball and verified against registry integrity; prior fixture
history is retained. No browser tests, UI changes, model calls or production
fixture writes are involved.
