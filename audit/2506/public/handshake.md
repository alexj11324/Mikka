# G-016 · Hibernatable close behavior on the pinned runtime

Baseline `b19eed9081d9858686d57547e7afcec73d6e9005`. Device and World compatibility date 2026-10-22. Wrangler 4.152.0, Miniflare 5.20261019.2-beta, workerd 1.20261019.1, Node 24.22.1.

Cloudflare documents automatic reciprocal close on and after 2026-04-07 ([DO base class](https://developers.cloudflare.com/durable-objects/api/base/#websocketclose), [Workers flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-auto-reply-to-close)). The isolated fixture here uses only local workerd, ephemeral objects and a loopback wire client. A close receiver listens for the actual reciprocal frame, independently of the socket FIN.

| Hibernating DO behavior | Peer close 1000 |
|---|---|
| Handler that explicitly replies | Server frame 1000 |
| No close callback | No server frame within 2.5 s |
| Application cleanup only | No server frame within 2.5 s |

In the real device route, unchanged `cloudflare/device-gateway/test/runtime.test.mjs` passed the single no-status test on the baseline. Removing only the reciprocal frame from that product callback and keeping its cleanup caused the same test to time out waiting for close in CLOSING state. The pure model of 14 presence transitions alone passed, which does not establish transport behavior. The broad concurrently run gateway experiment had additional timeouts during upgrade, so only the isolated matched test and wire probe are used for this conclusion.

The [pinned hibernating callback dispatcher](https://github.com/cloudflare/workerd/blob/v1.20261019.1/src/workerd/api/global-scope.c%2B%2B) invokes the exported handler; the [pinned legacy hibernation manager](https://github.com/cloudflare/workerd/blob/v1.20261019.1/src/workerd/io/legacy-hibernation-manager.c%2B%2B) routes received close frames to it. The ordinary WebSocket read loop is a separate path. The callback currently has an independent observable consumer in this pinned configuration. G-016 retains the wire reply until a supported runtime is shown to complete the same hibernating wire close, and retains business watch cleanup. External production runtime behavior has not been observed for this experiment.

Run from a checkout with its locked dependencies: copy the adjacent handshake.cjs to the repository root, then run `node handshake.cjs`. The fixture never contacts a Cloudflare account.
