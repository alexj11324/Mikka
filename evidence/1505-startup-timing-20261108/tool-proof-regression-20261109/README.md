# Independent execution tool proof regression

Owner change: #1805 commit 37ffccac0e76bd32885178eef9a300dedcb9315f, tree 447a9a83f86860494364382a3b5d545d95748f40, parent 5fde6ffae3c01769b69aa9c14abec26f2ceddfda. The exact two source blobs are in source-hashes.json and that immutable commit; this folder preserves execution evidence.

Actual Node 24.22.1 ran the same final 73 cloud-startup tests against the original driver (68 pass / 5 fail) and patched driver (73 pass / 0 fail). Final complete original log bytes are preserved and SHA-verified. Tests use the existing fixture: this is not a production subscription, actual native CLI execution or five-second timing result. The first counterexample and focused suite are retained too.

The four canonical terminal handoff tools do not count as an independent completed execution tool. Their original successful audit rows are kept. Current full-replay input identities and successful independent call hashes determine ordering and minimum count; an error withdraws that call's success. No new serialized evidence field, validator/formal schema, normal product SQL, dispatch path or timing formula is added.

## Environment preparation failures retained

An initial oversized command failed before execution with argument-list-too-long; the payload was split into bounded argument chunks. Actual test dependencies were then installed. The file prefix preinstall-attempt is a historical filename: those failing tests had dependencies installed, but the minimal source checkout lacked dynamically imported repository helpers.

Subsequent missing-docs-helper, missing-models and missing-finalization attempts were environment preparation failures, not accepted regressions. Missing unchanged source files were added until the exact final suite ran. Initial preparation output and captured helper failure files are retained. One helper RED log was sampled by the provider, so its partial frames with original sequence indices are in partial-log-capture.json; it is not represented as a complete original. The final missing-models/finalization capture command cmd_62021d2c6f4f4313b30cf22e5068 completed exit 0, but its return was not captured before session expiry. A subsequent read received sandbox_stopped (410); no reconstruction or rerun is substituted. Their observed counts were RED 67/6 and GREEN 72/1, before the missing finalization/certificate source was supplied. Both final 73-test RED/GREEN logs are complete and independently match their original emitted byte hashes.

The private VM sbx_bcaBBgSVQnPESl9fLEAyZ0fcNH7F had no production credentials or business operations; it stopped by its 900-second timeout at 2026-11-09T09:44:31.438Z, confirmed with a later GET. No explicit stop call is claimed. This folder does not claim a complete repository checkout, pnpm worker installation, full build/typecheck, new head CI, or production outcome.

Historical R89's marker-absent failure is not reclassified. New formal CC×3/CX×3 samples remain zero.
