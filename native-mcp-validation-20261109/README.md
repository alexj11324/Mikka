# Codex MCP outcome and native first-request validation — 2026-11-09

This archive separates the product MCP-status fix from a bounded offline native first-request probe. It preserves the primary-host failures, actual RED/GREEN, complete real-Linux related tests, native request/cleanup originals, merged-tree checks and VM shutdown. No test was rerun to prepare this archive, no new VM was created, and this evidence commit moves no ref.

## Source and result boundaries

| Evidence | Exact source | Actual result |
| --- | --- | --- |
| Primary MCP focused RED | Exact a709 adapter/protocol, six new regressions | 4 passed, 2 failed, exit 1 |
| Primary MCP focused GREEN | f044 product bytes | 6 passed, no failures/skips, exit 0 |
| Primary related attempt | f044 product bytes | 23 passed, 37 AF_UNIX environment failures, 2 pre-existing skips |
| Primary daemon typecheck | f044 product bytes | Exit 0, empty stdout/stderr; earlier wrong launcher-path failure retained |
| Real Linux complete three-suite run | f044f22d31f8fc2becdce02708ca0b4c033bcc93 | 60 passed, 2 pre-existing Cursor skips, no failures, exit 0 |
| Real Linux cold/adopted-style native probe | Fixture af38c3642239bd3791820ba7fad4b3bfe26af7cc; four Mikka files pinned to 869; official Codex 0.166.0 | Actual first requests captured and cleanup verified in both cases, with material fixture limitations below |
| Official preservation unit tests | Uncommitted combined tree a578997ffcb45caa6e5aae793a1d2116819aee30, including f044 and 4bff | 29 passed, exit 0 |
| Five related Node files | Same a578 tree | 194 passed, no failures/skips, exit 0 |

Root later created unreferenced normal merge bcb7ea695a07e479ef2c6fd52332a6f098d1f1fb, tree 6748ac1196b68773b198ae5a690db4122a287fcb, with ordered parents b7c5018597f293222488cc0a245a1e2d134a21c2 and 4bff6e5c00bdd43153aaca2d350b675b8df0e179. GitHub commit readback verified these bindings. The only difference from tested tree a578 is the ADR wording change; that later tree was not rerun. At root's report the PR ref remained 869. No new full-repository CI result is claimed for bcb.

## Product MCP correction and host limitations

Official Codex maps MCP isError results to failed status with a result and null error; the app-server result drops isError. f044 makes the existing adapter emit tool-output-error for explicit failed status, preserving explicit errors and normal started/completed behavior. Its fixed fallback does not copy result content into the error text. The actual six-case RED/GREEN, unchanged-test compatibility cases, exact patch, new test source, hashes and typecheck outputs are under host-adapter/.

The host's full related attempt is retained as a failure: 37 adapter tests failed at Unix socket creation/listening with EPERM. A single diagnostic confirmed AF_UNIX socket creation itself was denied before bind. No alternative-location retry or bypass was attempted. The other 23 tests passed, including all 17 existing MCP backend tests. The two skips are the existing Cursor question-continuation skipIf cases in adapters.test.ts. The first typecheck used a nonexistent tsgo.js path; that failed launch remains separate from the subsequent successful actual .bin/tsgo check.

The real Linux VM ran all three complete files after a frozen install on exact f044. Its 60/2/0 result resolves the host socket limitation for that source; the two deliberate Cursor skips remain explicit. The archive does not rename skipped tests as passes.

## Native capture: observed facts and limits

Both cases received mcpServer/startupStatus/updated starting then ready. Ready was observed at 465.509 ms for cold and 364.804 ms for adopted-style. The first actual marker-bearing model request was request number 2 in each case, at 509.058 and 393.336 ms; the warmup request did not satisfy capture. Both used WebSocket with the unchanged official gpt-6-luna metadata, and both native processes and tracked descendants were drained with cleanupVerified=true.

Both cases also emitted the actual warning that the standalone official tar's adjacent codex-code-mode-host executable was missing and Code Mode was unavailable. The captured request exposes exec/collaboration-style definitions but no inspect_artifact, inspect_repository or submit definition; the complete bodies contain no named inspector capability. This is not proof of a lost production catalogue. It also does not establish a complete usable indirect catalogue or successful tool execution: the mock provider returned synthetic response events and issued no tool calls.

The fixture placed HOME beneath its case TMPDIR, so the native CLI refused PATH helper aliases under a temporary directory. Native stderr, including the separate bubblewrap fallback warning, is preserved. These are explicit fixture/environment limits, not established production defects. The cold/adopted-style boundary fixture does not execute the complete daemon anonymous-adoption flow. The additional mock line stopped after this run; complete official CLI capabilities remain for the next actual candidate's real subscription gate.

The 509.058/393.336 ms values are offline mock measurements only. They are not production five-second startup evidence, provider latency, subscription success or an explanation of historical R89/P0 failures. The first primary attempt is retained under primary-native/: the missing CODEX_HOME directory prevented a first request, and ps failed with a host runtime error. Empty descendant lists from that failed scan do not establish cleanup coverage. No adopted-style result was produced by that first failed attempt.

## Original bytes and reproduction material

linux/capture.json is the complete 338897-byte capture, SHA256 fad1e8c5d1f5eefac32fc0c192c9fe3339f1f58fe6057c69bb0cf1084891944e. All 65 recorded text files are also expanded under linux/; each path, byte count and SHA256 was independently checked against both the capture and restored local bytes. The 83507-byte transport gzip had SHA256 5f618743c86db3d37d367a054c9c9d8cb65b67a50065b607e88800a4cf136395 and decompressed to exactly that capture. Its bytes are omitted; its metadata is retained in context.json.

The tool's displayed long command args are visibly truncated. They are not the source for replay. The full setup-driver.cjs, validation-driver.cjs and fixture-load-driver.cjs, plus the exact fixture.mjs and prepare-model.py, are preserved from the actual invocation/capture with their hashes. Native stdout/stderr, RPC, synthetic request bodies, notifications, per-case result and original-Mikka file copies are all retained. The model file and executable/tar are not copied into this evidence commit: their official immutable URLs, byte counts, Git blob where applicable and SHA256 values are preserved as asset metadata. The official 539696-byte models.json was unmodified.

primary-native/README.md is the original pre-run preparation note and retains its historical status. host-adapter/manifest.json is likewise the earlier host manifest; the top-level manifest.json covers every file in this combined archive, including later additions. context.json binds each result to its source and names all limitations. Source-preserving copies were used; no raw result was edited to improve its outcome.

## Real commands

Linux adapter suites, working directory /vercel/sandbox/issue1505/repo/packages/daemon:

```sh
node node_modules/vitest/vitest.mjs run test/codex-item-chunks.test.ts test/adapters.test.ts test/mikka-mcp-backend.test.ts --reporter=verbose
```

Linux native fixture, after the preserved setup and frozen installation:

```sh
timeout --signal=TERM --kill-after=5s 115s node /vercel/sandbox/issue1505/fixture/fixture.mjs /vercel/sandbox/issue1505/assets/codex-x86_64-unknown-linux-musl /vercel/sandbox/issue1505/repo /vercel/sandbox/issue1505/fixture/results-02 /vercel/sandbox/issue1505/assets/official-models-0.166.0.json
```

Root supplied the exact a578 commands, executed in /workspace/scratch/263e36984c81/Mikka-1505 on Python 3.12.14 / Node 24.22.1:

```sh
python scripts/e2b/official-files.test.py
node --import ./tests/support/server-only.mjs --import tsx --test scripts/e2b/runtime-report.test.mjs scripts/e2b/validate-template-subscriptions.test.mjs scripts/e2b/publish-template-env.test.mjs scripts/acceptance/cloud-startup.test.mjs scripts/release/web-deploy.test.mjs
```

## Resource closure

The one real Linux VM sbx_968Mad3ajBrkaNNqnU9TVh7V6lFC used 2 vCPU / 4096 MiB and Node 24.22.1. Root stopped it at 2026-11-09T14:38:12.628Z; the stop response and a separate subsequent GET both report stopped. The recorded duration is 657154 ms. Original create, stop, GET and export tool metadata are under linux/. No VM remains required by this archive.
