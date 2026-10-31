# Model admission (#231)

The workspace policy row owns `model_admission`; there is no second policy
registry or execution epoch. Policy contents are exact model/serving-provider
allowlists, fixed Gateway transport, optional principal IDs and explicit data
region requirements. Unknown data region is not evidence of regional routing.

The initial store uses the existing central workspace membership lease and
write transaction. Only an active administrator may publish a policy. Writes
compare the previous content revision and append an allowlisted existing audit
row in the same application transaction. A different workspace is unchanged.
No credentials, rule contents or prompt text enter policy audit metadata.

The first independently tested increment contains the contract and persisted
store. Model consumer wiring is a subsequent increment; this document does not
claim that a store by itself gates live providers or completes #231.

Validation: cloud Linux, PG17 on loopback port 55599, isolated database
`mikka_admission_closeout_e2e`, all 155 migrations. Contract tests: 3 passed.
Real PostgreSQL store tests: 7 passed, zero skips. Root types, focused lint and
diff checks passed. Logs: `/tmp/mikka-admission-store-core.log` and
`/tmp/mikka-admission-types-audit.log`.

Outstanding acceptance includes live model requests, child/fallback transport,
native CLI model enforcement, actual provider-region evidence, and the main
site user path. A mock provider, database test or model name is not that proof.

Risk estimate: policy bypass across principal/workspace or provider routes is
occurrence 6 × impact 8 = 48. This is an engineering estimate. The concrete
gap is that current model selection/billing lacks an organization model route
allowlist; the store and its tests address only persisted rule authorization.
