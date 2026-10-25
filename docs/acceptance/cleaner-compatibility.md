# Cleanup-only compatibility release

Base: main666ae4604301454b634b10678e57dd12d16d7509. Reused credential files are copied unchanged from reviewed candidate26bb41c34f0c29f1ba7f71a6d9e7bce46bd00098. Their original authors remain in that source history; this commit composes only a cleanup endpoint. No admission, browser executor, provider tool, UI, SQL migration or cron change is enabled.

The separate cleanup-runtime uses the existing application/workspace pools and public credential authority, Universal Auth and exact vault deletion. The broker's browser dependency is type-only and no browser is instantiated. The direct playwright-core dependency supports typechecking the retained source implementation; it does not enable browser execution. No new credentials are included.

Production requires the already approved credential schema and the explicitly approved server-side cleaner configuration. Build migrations contain only current-main files; they must still be checked against the production ledger before deployment. The new audit and device-revocation SQL from #280 are deliberately absent.

Validation: 13 authentication/HTTP transport tests, isolated PostgreSQL cleanup lifecycle/retry/concurrency test, typecheck and lint. The PG test uses actual Postgres/advisory locks and the real authority implementation; vault operations are explicitly a synthetic transport test double. This is not real Infisical or production acceptance. CI runs these tests with PG17 plus the complete production build. No claim is made that the legacy build job name includes ordinary browser testing.

Release sequence: review this exact candidate, deploy without changing daily Linear cron, create only the separately approved three synthetic cleaner objects, verify exact deletion and retained tombstones, enable the existing Cloudflare minute trigger with its existing CRON_SECRET, verify scheduled execution, then remove the Vercel minute cron from the full BYOS candidate and retest it. Real cleanup is not proven by a 200/checked count alone. Existing unrelated rows must not be swept under a fixture-only deletion authorization.

No source PR/branch is deleted and no production data or schema is modified by this code preparation.
