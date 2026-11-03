# Idle computer-review traffic

Branch: codex/computer-review-idle, base6e8081033c13d0f71bf09c2fc8fe23c402e35e1b.

Production requests showed the device computer-review endpoint continuing at
roughly one call per second while an aggregate database check found zero recent
pending reviews. The daemon loop uploaded an empty broker snapshot every tick.
Occurrence10/10, impact4/10, score40. These observations identify idle work;
they do not attribute every Neon billed byte to this endpoint.

Send one initial cleanup, synchronize at the original cadence while local calls
need approval, and send an empty transition after the last request disappears.
Retry failed cleanup because a failed response may still have updated the
server. An idle broker checks locally without sending network requests.
Digest binding, device/run ownership, permission rechecks and driver execution
are unchanged. No production migration is needed.

Regression: the new idle test failed on the original loop (7 requests where one
was expected) and passed with the fix. The real broker/scripted MCP child tests
cover approval, permission revocation, replay prevention, transport retry,
cleanup retry and abort. Real isolated Postgres local-review and computer-store
suites passed (2 tests); broker/driver tests passed (32). Daemon typecheck and
package build passed. Full daemon suite passed677 with2 skipped, plus its Node
CLI/identity/credential/endpoint suites. Initial full-suite failure was the
existing0755 fixture precondition under inherited umask0077; normal umask0022
resolved it without product changes.

Publication alone does not update every running daemon. Follow the published
package SHA/version and real device-request rate, including cloud workers,
before claiming an idle-traffic reduction. Keep provider bytes, sample JSON
estimates and HTTP bytes separate.
