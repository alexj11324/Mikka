# Review repair evidence at 290fa7d

Source: 290fa7d8d0f607ae9f14ad7b23bc61ed58adfe31, draft PR #264.

Actual isolated cloud Linux Next development/on-demand run: 71 actual HTTP requests passed (72 records included one duplicate annotation; fixed at 721bbf3), including actual synthetic OAuth mka_ tokens, four Notion/Slack tools, server-derived owner/workspaces, first policy publication/revision/revoke after authentication, member suspension/removal, expired/revoked token, expired session, disabled client and six authenticated delayed bodies sharing a committed policy revocation. Unmanaged tools return their existing composioNotConfigured result; managed tools return policy denial before client construction. No external provider keys are configured. Real PG separately proves denied callback count zero and an admitted callback fences publication. Local owned resource reads and stop remain available under fresh OAuth validation.

This run includes a **test-only DB overlay** of audit #259 1b39b709ce361b9643524aea983860e6de818ff6's original application SQL (hash in environment.json). Policy source remains based on original audit 9532817. Ordinary continuation A moved to unmanaged B is rejected with policyScopeMismatch, remains queued and receives zero run tokens. Personal historical parents and Factory questionContinuation without a DB continuesRunId are both rejected with policyScopeUnverified. No production backfill. This is NOT the final combined source/deployment acceptance; the parent must integrate reviewed audit fixes and reverify the final SHA. Ambiguous legacy personal resumes are intentionally refused.

21 policy checks passed without skips: 5 contract + 3 SDK + 10 PG subcases + their parent + 1 application-PG scope test + 1 SQL adapter. Actual SDK retryable 503 tests additionally change policy in real PG (publish/revoke/revision), proving sends remain one after a later gate rejects. Root types/lint and 89 Coordinator cases passed. This intermediate SHA was superseded; its incomplete CI is not a green acceptance result.

Original video is a direct browser recording of actual policy endpoint reads/rejection/read, 1280x800 VP9, 5.2 seconds. It shows only synthetic identifiers, signatures and public keys. It does not record every API case or claim real provider/production acceptance.

Earlier d11 CI production build passed but its four rapid signup fixtures triggered the existing signup 429. Failed evidence is retained. The final harness reuses two users; no authentication/rate-limit configuration was changed. Old SHA successes are historical, not this candidate's CI proof.

Managed positive providers remain unavailable pending #215 budget adapter; worker/CLI/child transports and signed effective assignment/cache/TTL/approval binding, actual OAuth identity and frozen deployed Preview/production acceptance remain incomplete. Both issues stay open and PR stays draft.
