# Frozen mailbox and workspace integration

Base PR280 `26bb41c34f0c29f1ba7f71a6d9e7bce46bd00098`, then PR272 `ee5ae6a0f1d8804fd58a18c80652545fc38cbaaa`, then PR277 `58117e2806c2078328a6cdc90ad7bf9b5c8db91a`. Source branches preserved. No frontend changes authored by this integration.

Conflict resolution keeps the transactional group claim callback and exchange command, plus existing workflow exclusions. The combined candidate runs both audit and exchange workflows and excludes live OIDC credential access on this branch.

Independent review found a multi-dispatch poll pool cycle beyond the single-command lazy acquisition fix: a poll retained workspace authority after the first app transaction and borrowed another app connection. Five polls and five writers could exhaust both max5 pools. Production worker ingress now scopes authority separately around each dispatch; other commands retain one scope around their command. Membership locks still cover app commit; each dispatch rechecks device and membership. No timeout increase, lock removal, or retry masking.

`test-group-poll-pools.ts` exercises five real two-dispatch polls at the second app borrow, with five concurrent writers holding app connections before borrowing workspace. The former outer-authority mode reproduces acquisition failures; per-dispatch mode completes. Fixtures remain retained. The test rejects URL query overrides.

Validation distinguishes handler/Postgres lock tests, actual Next HTTP exchange requests, shipped MCP stdio/socket recovery, and CI builds. Infrastructure retry/token creation in MCP acceptance is controlled fixture SQL, not daemon automatic reclaim. No real provider, production SQL, deployment, or production user acceptance is claimed. R alone coordinates main integration.
