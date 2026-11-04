# Passive database connection metadata

Prepared only; do not activate without the coordinator reviewing the exact source and workflow. The source checkout is fixed to 5b81321dfd3bbc3413d71af258433e5e9ba73dfb. Production `lib/db/config.ts` selects MIKKA_DATABASE_URL for the group/application pool; DATABASE_URL is the separate workspace database, not a fallback for this diagnostic.

The workflow uses the existing GitHub OIDC identity and reads exactly Infisical project 89850d6a-f020-4936-863e-df77380dfe40, prod, /vercel, MIKKA_DATABASE_URL. No dependencies are installed. The script never imports the application database module or a database driver, never connects, never executes SQL and never invokes a model. It emits only the recognized Neon pooled/direct classification and safe source metadata. Host, endpoint ID, database, username, password, query parameters and the original URL are not emitted or saved. An unsuccessful named read or an unrecognized URL means unknown, never production-variable absence.

Neon documents that the endpoint -pooler hostname suffix selects its transaction pooler: https://neon.com/blog/survive-thousands-connections . This classification is based on that documented naming convention; it is not a network observation. The source of the inspected value is explicitly Infisical, and `directlyObservedDeployedValue` remains false. Comparing it with the exact deployed Vercel value is a separate evidence step if required.

The cloud worker source commit 3def948dd00ec5aac59a04f6bc043a1d291d7683 was supplied by the coordinator from an existing non-secret Vercel plain setting. It is recorded as previously observed, not newly queried by this script.

Offline checks completed: `node --test db-connection-metadata.test.mjs` (3/3, zero skips) and `node --check db-connection-metadata.mjs` (exit 0). The tests only parse synthetic strings and guard workflow scope. No actual connection value has been read by this preparation step.
