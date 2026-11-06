# Self-hosted Mikka follows LobeHub: full features, cloud-only abilities through Mikka Cloud services

- Date: 2026-11-06
- Source: Alex, 2026-11-06, relayed by the coordinator: 「Mikka 的自托管版本完全照 LobeHub 的做法来」. Self-hosters use the official desktop app (and later iOS) against their own server; no feature is cut. Abilities that need Mikka's own accounts and keys (GitHub App, cloud computers, push and so on) are centralised in Mikka Cloud, like LobeHub's Market, and a self-hosted server gets them by connecting a Mikka Cloud account; an advanced option to bring every key yourself stays.
- Rule: —
- Replaces: —

Design: [`../self-hosting-cloud-services.md`](../self-hosting-cloud-services.md).

What follows from it:

- The public repository runs the whole core with no Mikka account: sign-in, bots, threads, daemons, cloud computers on the person's own E2B key, own subscriptions and API keys, and live push without Cloudflare. `MIKKA_EDITION=community` is the default; Mikka's hosted deployment sets `cloud`.
- Abilities that only exist with Mikka's own keys run in a separate deployment, Mikka Cloud services, from the private repository `mikka-cloud`. Its API contract is public in this repository.
- A server connects in two ways, both supported: a person binds their own Mikka Cloud account (OAuth code + PKCE against a dynamically registered server), or an admin configures a server key from a Mikka Cloud team workspace (client credentials). Usage is billed in Mikka credits to the bound person's chosen workspace or to the key's workspace.
- Efficiency stays first ([1800](2026-11-06-1800-machine-is-the-execution-boundary.md)): real GitHub installation tokens and machine credentials go to the machine at preparation; tokens are verified at the cloud endpoint itself; no per-call proxy is added.
- Desktop and iOS keep the loopback/PKCE and `mikka://` returns; LobeHub's polling handoff is not adopted ([0200](2026-11-05-0200-no-new-polling.md)).
- Open for Alex: billing cloud computers in Mikka credits for connected self-hosted servers reverses, for that path only, the 2026-10-30 row in `../decisions.md` (E2B only on the person's own key, no Mikka billing). It is designed as an option and is not built until Alex confirms.
