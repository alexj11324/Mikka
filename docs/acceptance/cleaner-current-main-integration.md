# Cleaner diagnostics on current main

This candidate is based on main 470c5cd4873634ff2b992598349ab52cffe1ee62 (including #299). It preserves the SSR dispatcher correction, unread observer behavior, actor, search, and other merged owner changes.

Source mapping: #281 657f4152 provides the cleanup-only composition; #284 commits 7d7c3dde, 735f0d6f and a7475a83 provide redacted failure metadata; #302 40dfe967 provides bounded Universal Auth classification. The original commits are cherry-picked with authors preserved. No Cloudflare scheduler, SQL migration, UI change, or credential/configuration update is included.

The current main required-DB inventory enrolls cleanup-postgres.test.ts under test:cleaner-db, requires it when cleanup-runtime.ts exists, and rejects skips. The synthetic PostgreSQL test exercises tombstones and retries with a vault double; it is not actual Infisical cleanup acceptance. Authentication tests use synthetic loopback HTTP and fake clocks, not a real identity login.

## Later authentication-only verification (not executed or authorized by this candidate)

Target: the existing Mikka Vercel server-side environment's configured Infisical origin, historically https://app.infisical.com, POST /api/v1/auth/universal-auth/login, using existing CLEANUP_CLIENT_ID and CLEANUP_CLIENT_SECRET. Before execution, compare the configured origin and non-secret client ID to the existing approved identity. Do not create, copy, rotate or resynchronize credentials. A fresh login necessarily transmits the existing client credentials from that backend to Infisical and mints an access token on success; it is not a new persistent credential configuration.

One server-only invocation should return only success/failure, numeric HTTP status, the fixed diagnostic enum, optional hashed request ID and token lifetime. Keep any successful token only in process memory, then discard it; never return token/body/message to an operator or browser. No vault read/write/delete, cleanup sweep, SQL or provider call is part of this check. A denial may consume an attempt or trigger the identity's existing lockout; retain the local 401/403 latch and do not retry.

There is currently no authentication-only production endpoint in this candidate. The cleanup route is NOT a safe substitute: calling it can delete vault objects. Execution therefore still requires an explicitly approved controlled server-side one-shot mechanism (and reviewed code deployment if needed), rather than a public diagnostic route or use of the cleanup endpoint. This document neither performs nor approves that action.

The underlying production 401 remains unresolved. Candidate tests only establish safe diagnostics and compatibility.
