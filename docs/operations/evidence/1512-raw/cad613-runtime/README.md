# cad613 historical runtime failure evidence

This directory preserves the original failed-candidate receipts and a bounded follow-up diagnosis. It is historical failure evidence, not production acceptance for #1512.

- Source: `cad613ef0a2c553a94aaf72d44d609c93a603a1b`.
- Main runtime workflow: `42336625140`, attempt 1; build/conservation and Claude passed, Codex failed, publication skipped.
- One-shot normal owner diagnostic: `42340265289`, attempt 1, source commit `91579b902d837e6e37f7c1e32387b52d8ade8e51`. It signed out and cleared cookies. Its partial status reflects the deleted issue preventing thread reads.
- Exact run: `f879d6cd-bdbd-4e62-9a17-441f1f763a25`; exact device: `09479c68-dcb4-4735-a91f-e355259c0eef`.
- Only closed metadata was returned by the subsequent production read-only SQL. No prompts, replies, raw error messages, token hashes, cookies or account email were queried or saved.

The original candidates.json bytes retain the complete conservation and model report. The catalogue contains gpt-6-luna, but cannot establish an authenticated subscription execution. Its null model-row version does not establish a CLI semver.

Repository and worktree stages passed. Agent startup failed after 459 ms, before an observed Codex task acknowledgement or text/tool output. The stored error's hash and 62-byte length match the fixed CodedError constructor output described in closed-error-match.json. That only identifies the outer hosted-runner error; the underlying cause is unknown. The historical validator did not collect the private daemon's rotating log before its VM was deleted.

The normal owner device list excluded the exact device; the later database projection observed its removal at 04:49:37 UTC, zero active issue/device runs, and zero valid bound/associated device tokens. No repeat removal, model call or VM creation was performed by the diagnostic operation. SQL files document the complete, fixed read scope.

## Preserved historical APM

Two bounded PostHog queries found actual trace `4d9fe13db9eec64004a6d1e1fa47088e` in project 670821, using only 04:26:35 <= timestamp < 04:27:05 UTC. Dashboard 2306506 metadata independently re-confirmed the project. The exact-run query returned 7 spans. The most specific observed error is `daemon.adapter.cli_init`, span `0a93a0cd2ba9b015`, 440.898 ms, type `Error`, with no usable safe code/detail or cause field. Model report was not marked Error. The enclosing adapter/start and run spans have the known hosted-runner wrapper.

Fixed-source inspection shows cli_init covers the initialize request and its readiness wait, before the normal initialized notification, explicit subscription login, thread creation and turn/start. This locates the failed boundary; it does not distinguish an RPC refusal, connection/writer failure or early process exit.

The second same-trace query returned exactly its 100-row limit. Its visible sample contains only spans; it is not a complete trace or proof of zero Logs. posthog-historical.json preserves both safe queries, returned projections and these bounds. No raw body, error message, stack, prompt or reply was returned.

The final issue #1512 production acceptance must use its own deployed source, actual APM/AI/Logs/Replay evidence, and resource-close receipts. None of these historical failures was reclassified as a pass.
