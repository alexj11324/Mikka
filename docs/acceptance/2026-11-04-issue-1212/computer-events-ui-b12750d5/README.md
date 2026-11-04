# PR #1231 — final-head local UI and incremental catch-up evidence

## Exact source and environment

- Application commit: `b12750d5b7006c6dbc7c7b5bec7acf8ace1b51ed`.
- Application tree: `199e54f9a6eed25f691fb30bc1c008fa0d1e63e7`; real merge of the original C branch and main `2ab9649b14b75b530172bfe51933e4f3b51f949e`.
- Existing Docker Cloud Sandbox Large; Node 24.22.2; isolated PostgreSQL with full repository migrations.
- Fresh database `mikka_c_b12750d5_e2e`, normal TestAccountPool environment `local-e6f70001-e133-4b4d-801f-502b183ece03`.
- `pnpm build` completed with exit 0. The local production server's version was required to equal the application commit before capture.
- Capture: 2026-11-04T19:04:49.769Z–19:04:57.493Z, exit 0. Origin `http://localhost:3491`.
- Native headed Chrome 157.0.8103.38 under a fresh Xvfb/Openbox display; CDP `noDefaults: true` avoids synthetic focus emulation.
- Eight downloaded PNGs were SHA-256 verified against the manifest and individually visually reviewed.

## What actually ran

The driver signed in through the normal TestAccountPool, persisted an isolated synthetic subagent, and used the real SubagentStore writer twice. The actual JSON endpoint returned two committed events at cursor 2; the preview rendered one existing login prompt, without a duplicate card.

The eight images show the existing login component in Chinese and English, at 1440×960 and 390×844, in light and dark themes. Labels remain legible without clipping or duplicate cards.

A second real browser tab brought the application into the hidden state at 19:04:57.449Z. While it was hidden, the real writer committed the next running state. Bringing the page forward caused a request with `after=2`; the actual HTTP 200 response contained event 3. The login card disappeared at 19:04:57.493Z. Neither visibility nor network responses were mocked.

The local gateway was deliberately unconfigured; the real ticket endpoint confirmed null URL/protocol/expiry. This proves the actual incremental JSON route, local component state, and foreground catch-up. It does **not** prove a healthy production WebSocket, a long-duration background run, external login, or native model execution.

## Verification tied to this source

The source gates ran on the final tree on 2026-11-04 18:48:55–18:49:15 UTC, using fresh fully migrated loopback databases:

| Gate | Result |
| --- | --- |
| Live PostgreSQL, COMMIT/ROLLBACK, cursor order and request scope | 42/42, zero skipped |
| Credential/broker regressions | 37 + 10 = 47/47, zero skipped |
| Gateway groups | 9 + 29 + 9 = 47/47, zero skipped |
| Incremental client | 6/6 |
| UI policy and focus | 247 + 9 = 256/256 |
| Type generation, typecheck, lint and diff-check | Exit 0 |

The exact-head [CI run 41891444065](https://github.com/alexj11324/Mikka/actions/runs/41891444065) and all eight companion workflows succeeded. All 29 checks completed: 24 success, five expected condition skips, no failures or pending checks. Independent broker isolation and all database shards passed.

The local evidence audit passed for nine files. Credentials, cookies, browser traces and recordings are excluded. The synthetic fixture was retained only in the isolated local database and its TestPool pair quarantined.

## Files

- [Manifest](manifest.json): exact source, environment, image hashes, actual cursor responses and real visibility observations.
- [Screenshot driver](capture.mjs): screenshot-only direct browser automation, not a browser test suite.
- [Runtime launcher](runtime.mjs): isolated database/bootstrap, production build and exact build check.
- [Chinese desktop light](zh-login-1440-light.png), [Chinese desktop dark](zh-login-1440-dark.png).
- [Chinese phone light](zh-login-390-light.png), [Chinese phone dark](zh-login-390-dark.png).
- [English desktop light](en-login-1440-light.png), [English desktop dark](en-login-1440-dark.png).
- [English phone light](en-login-390-light.png), [English phone dark](en-login-390-dark.png).

The earlier 2b70777c screenshots and failed CI/setup attempts remain historical evidence with their original source attribution. This record does not mark #1212 production acceptance or the fixed-task before/after measurement complete.

