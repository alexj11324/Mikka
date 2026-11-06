# Issue 1506: verify final candidates in the existing Docker sandbox

This is a development verification transport. It uses the existing sandbox `sandboxes/sbx_001m6rywbd7a5pjmqb79qs43vad`; it never creates a sandbox, deployment, database service, or app server. It does not replace PR CI or production acceptance.

The branch-only workflow is `.github/workflows/issue-1506-docker.yml`. Its exact branch is `acceptance/issues-1504-1506`; its path filter includes only this script directory and that workflow file, so a push limited to these files does not trigger the production routing workflow. Permissions are `contents: read` and `id-token: write`; concurrency serializes access to this exact owned sandbox, and the job limit is 20 minutes.

## Inputs frozen for review

- Base: `e8dd7a1265027a0477819dde1a80178e7bcdb1ae`.
- Stop patch: `c20d86ba8f1cd658be977c66f92cb5bdd81e023b90e943e26e76e72f269e0dfd` — 6 source files.
- Live patch: `31bcbe99d0e645a018616ed477e1ae18fd925a6fc79571b9f3a574ac88be692a` — 8 source files.
- `candidate-manifest.json` contains each resulting source file's SHA256. No overlapping paths are allowed. Both patches were applied together to temporary source-only files from the exact base; all 14 final source hashes matched. That check performed no remote requests and executed no product code.

These are the stop/live candidates supplied by their owners. The parent reviews them before pushing. The subsequent prompt-context concurrency proposal is not included; its different base and required RED/GREEN sequence need a separate reviewed input set.

## Credential delivery and API

The existing Notion credential record explicitly locates `DOCKER_ID` and `DOCKER_PAT` in Infisical `prod:/docker`. The workflow reuses the existing OIDC identity `2cf9fa19-b9db-4c08-8ca0-b31859f2cbac`, audience `mikka-infisical`, project `89850d6a-f020-4936-863e-df77380dfe40`, fetching those two keys individually. It creates no identity and changes no secret or policy.

Only the runner receives Docker credentials. `control.mjs` exchanges them at `https://hub.docker.com/v2/auth/token`, keeps the resulting management token in memory, and uses `https://connect.docker.com/sandboxes/v1/<fixed-name>`. Each endpoint token grants one operation class: files write, exec, or files read. Endpoint credentials are not sent to the sandbox process, written to files, printed, or uploaded as artifacts. A fresh endpoint token is obtained after long execution before reading its result.

A denial or transport failure produces a closed error and HTTP status. No command or failed HTTP operation is retried, and no proxy, alternate host, alternate identity, or permission change is attempted. The only repeated reads observe an accepted external Docker lifecycle transition (`starting`/`stopping`), bounded by 30 reads and 45 seconds; this is external API status observation, not application polling.

## Work performed

`control.mjs validate` verifies local patch/source manifest constraints before reading credentials. `verify` then reads the exact sandbox, starts it only if stopped, checks the returned endpoint belongs to the same immutable name, uploads five nonsecret code/patch inputs under a run-specific `/tmp/` prefix, and makes one normal `POST /v1/processes/exec` request.

The process creates a new detached `/workspace/Mikka-1506-verify-<GitHub-run>-<attempt>` worktree at the exact base. An existing directory causes refusal; it never resets, cleans, or reverses the old `/workspace/Mikka-stop` or `/workspace/Mikka-live` candidates. The original `/workspace/Mikka` checkout supplies matching installed dependencies via symlinks. Its existing `scripts/dev/bootstrap-local.sh` is run with exports captured, checked, then evaluated without printing. The test runner verifies all database URLs are the isolated `127.0.0.1:5432/mikka_e2e`, Node is 24, and all source hashes match before running checks.

The nine checks are: staged diff whitespace, stop core/subscription/agent-kit unit tests, stop store database tests, live channel/tab-share unit tests, live hook tests, typecheck, lint, polling policy, and idle budget. Each full stdout/stderr, exit status, duration, actual source hash, and runtime version is retained after redacting local test secrets. No browser acceptance or provider call is launched.

The remote process has an 840-second outer timeout, the runner's checks have a 780-second budget, and the controller reserves cleanup within its 16-minute work window. `finally` stops the exact owned sandbox on success or failure. An `always()` workflow step independently invokes `control.mjs stop` as a final safeguard; it also uses only the fixed sandbox. An unconfirmed stop is a failure, never a cleanup success claim.

## Results and local checks

`issue-1506-docker-report/verification.json` holds the complete sanitized result; `stop.json` holds the final stop observation. The workflow uploads these files even on failure. Source-only validation and offline mocks do not constitute final candidate verification; only the actual Docker return can establish which final checks passed.

```sh
node scripts/acceptance/issue-1506-docker/control.mjs validate
node --test scripts/acceptance/issue-1506-docker/control.test.mjs
bash -n scripts/acceptance/issue-1506-docker/remote-verify.sh
node --check scripts/acceptance/issue-1506-docker/remote-verify.mjs
```

The eight offline tests disable real network access. They cover exact source inputs, credential redaction, fixed-sandbox scope, stopped/running reuse, endpoint denial without retries or bypass, unknown exec acknowledgement without re-execution, mismatched remote source hashes, failure cleanup, and cleanup without candidate files. No remote command or sandbox mutation was performed while preparing this draft.
