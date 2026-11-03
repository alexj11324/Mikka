# Device work is pushed, and idle devices do not query Neon

- Date: 2026-11-03
- Source: Alex, GitHub issue #1156, and the follow-up that the design has to fit 500 people and 400 devices online on the Cloudflare free plan, with no Neon Functions and no second paid membership
- Rule: —
- Replaces: —

A device learns that work is waiting from a Cloudflare Durable Object, one object per device, over a hibernating WebSocket. The server posts an empty signal after it commits the work. The device then reads that work through the existing authenticated route. The 30 second heartbeat is the text `ping`, which the object auto-answers without waking and without a database write.

The long-poll remains for a daemon that has no gateway and for a gateway that refuses the connection. It still checks every 2 seconds, because a revoked credential has to fail the next check within the existing bound. A connected daemon does not sit in that poll, and while it is idle and holding no run it does not heartbeat the database either.

Production `suspend_timeout_seconds` is 0 today, which keeps the compute awake. That is a Launch setting. This change does not edit it. On the Free plan, scale to zero cannot be disabled and the compute suspends after 5 minutes with no queries. Idle devices on the gateway produce no queries, so that suspend can happen. Neon Functions are not used.

The template worker hash covers the daemon install, not root `package.json` scripts and not lockfile entries that only the web app installs. An unchanged hash, or production environment variables that already match, does not rebuild the template and does not redeploy production. A merge that only changes product code or docs still has the one Git-triggered production build.
