# Native and question HTTP acceptance profiles

Base: PR291 `aa86f41d32bd3c1fe42d6d2eba63e6b1614e1fa5`. PR171 runner inspected at `4f9ec40c534af180154ad307a44e2f44822d1603`. This change does not edit `scripts/run-db-tests.mjs` or remove existing `mailboxes.yml` native configuration. The shared runner owner must consume the phase/profile distinction; do not classify these files as exclusions.

## Required native profile

`pnpm test:group-native` declares `lib/group-mailbox-runtime.test.ts` explicitly. It requires all 10 node:test results, zero skips/failures/cancellations, and the named native subtest `actual daemon startup routes BOTH CC/Codex CLI adapters with isolated fake binaries`. `test:groups` also includes the file, but without `MIKKA_TEST_NATIVE_GROUPS=1` the native child is not registered; a zero-skip summary alone does not prove native execution.

The recipe sets `MIKKA_TEST_NATIVE_GROUPS=1`, `KEEP_GROUP_TEST_FIXTURES=1`, and `KEEP_NATIVE_TEST_FIXTURES=1`. Supply a validated loopback `MIKKA_DISPOSABLE_POSTGRES_URL` and, only after explicit authorization for the test-owned runtime disposal, `MIKKA_NATIVE_DISPOSAL_AUTHORIZED=1`. Direct native entry also checks that authorization, so calling the file through another command cannot bypass the gate. Existing mailboxes native flag remains intact; its owner must explicitly authorize and configure runtime disposal before running this new guarded version. Missing authorization is a failing prerequisite, not a successful exclusion/skip.

Retention covers database schemas/rows, test daemon data directory, image build directory and built images. The ACK fault trigger is retained and disabled using a fixture row UPDATE. The cleanup-failure marker is renamed rather than deleted; recovery only removes container names recorded by that test's shim. Production adapter semantics still remove containers, cancel processes and remove runtime config directories. Those operations are part of the real cancellation/isolation tests and cannot be declared retained by setting KEEP_GROUP_TEST_FIXTURES. Do not fake successful disposal or relax production cleanup assertions. No live vendor inference is performed.

## Required post-build Factory question HTTP profile

`pnpm test:factory-question-http` declares `tests/factory-question-http.test.ts` explicitly. Run only AFTER a real build and a running `next start` server. Preconditions: `FACTORY_QUESTION_LOCAL_HTTP=1`, `FACTORY_QUESTION_HTTP_ORIGIN=http://localhost:<port>`, and a loopback `FACTORY_QUESTION_DATABASE_URL` using role `factoryquestions192` and database `mikka_e2e`, without URL query overrides. `.next/BUILD_ID` must exist. Exactly one named test must pass, without skips.

The recipe forces `FACTORY_QUESTION_RETAIN_FIXTURES=1`. It keeps all synthetic rows and avoids sign-out's physical session deletion, checking the anonymous denial independently. The receipt records retained question/session counts. This profile does not claim sign-out deletion coverage. No schema reset, DROP, DELETE, container removal or server-stop hook is supplied by the recipe.

`.github/workflows/factory-question-http.yml` provisions its own ephemeral service with the dedicated role, applies tracked migrations, builds, starts compiled Next and runs the HTTP recipe. It does not add this test to the pre-build DB runner. `scripts/backend-acceptance-profiles.json` supplies the two profile/phase/count mappings for the runner owner to integrate without double registration or silent coverage loss. Retaining fixtures within a job does not promise persistence after the CI platform destroys its ephemeral runner.

No production deployment/provider/credential operations are authorized by either profile. Neither profile completes production acceptance.
