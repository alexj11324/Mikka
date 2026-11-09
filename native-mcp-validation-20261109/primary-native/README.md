# Native MCP first-turn fixture, 2026-11-09

This is a bounded offline native RPC boundary probe for issue #1505.
It is NOT production, subscription validation, a startup benchmark, a daemon-adoption
end-to-end test, or an explanation of historical R89/P0 failures.

## Fixed inputs

- Mikka source: 869c71d7aa062c76fc7a75c1f8775d1ed8538168.
- Official Codex tag: rust-v0.166.0, annotated tag
  593389380740f7b4762771573c447ccfdc59742f, target commit
  6ff1e1ca3b30fc8b914720681fcf5fe62e95f856.
- Release asset:
  https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-x86_64-unknown-linux-musl.tar.gz
  121764138 bytes, SHA-256
  a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978.
- Root already downloaded and verified the binary; do not download it again.
  Extracted binary: 319346888 bytes, SHA-256
  b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8.
  Root observed --version exit 0 and stdout codex-cli 0.166.0.
- Official models.json is loaded without changing a byte:
  https://raw.githubusercontent.com/openai/codex/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/models-manager/models.json
  Git blob 489ebe3f2483348641a16160ce8491dd077eabca.
- Four Mikka MJS files are read with git show from the fixed source and copied,
  unmodified, to the output directory after checking their Git blob IDs.
  No products or branches are changed.

## Scope and controls

Two cases only: cold MCP configured by native CLI arguments, and adopted-style
MCP configured by thread/start after initialize. Both use real official binary,
real Mikka backend, --factory-artifacts, and the adopted case's real unchanged
private-context wrapper. This replays the native boundary, not the complete
anonymous-codex-spare eligibility or daemon flow. The context file is created
by the fixture using the wrapper's exact schema, owner-only directory/file modes,
and fresh runId/nonce; the TypeScript context writer is not executed.

Both use isolated synthetic HOME with CODEX_HOME exactly HOME/.codex, an
environment whitelist, a synthetic cwd/file, no account/login/start, no tokens,
and a custom loopback-only mock provider. This is fixture isolation and does
not change the product's ordinary-HOME design.

Official gpt-6-luna metadata is unchanged, including code_mode_only,
supports_search_tool, use_responses_lite, and prefer_websockets. The provider
supports both HTTP and WebSocket, with WebSocket support enabled. The mock server
records the first request containing the unique synthetic user marker; warmup
requests without that marker cannot satisfy the assertion. The server returns
synthetic response events and never issues tool calls.

No MCP required flag, startup grace, tool permission, or model metadata is tuned
to obtain a passing result. Readonly shell-tool-disabled behavior matches the
investigated boundary. There is no pre-turn status/list readiness wait.
No initialize delay is introduced in this first batch.

The output preserves all synthetic native RPC frames, native stderr, and model
request bodies. Named tool booleans are derived only from tools arrays. Because
official metadata can use code/search representation, false does not prove
unavailability. The initial pass criterion is that both actual first requests
were captured and native processes drained; catalogue interpretation is a
separate review of the captured representation.

Each case has a 45-second deadline, and the fixture a 105-second hard deadline.
The cleanup closes stdin, signals the native process group and tracked
descendants, waits/reaps the native parent, and records process-group and
descendant state. It stops before a second case if the first did not reach a
request or process cleanup did not finish. Do not leave the process running
after the outer timeout.

## Host commands after review

Files belong under:
  /workspace/scratch/263e36984c81/native-mcp-first-turn-1505

Use the existing binary:
  assets/codex-x86_64-unknown-linux-musl

First materialize these two scripts outside the product checkout. Then:

    python3 prepare-model.py /workspace/scratch/263e36984c81/native-mcp-first-turn-1505/assets/official-models-0.166.0.json
    node --check fixture.mjs
    timeout --signal=TERM --kill-after=5s 115s node fixture.mjs /workspace/scratch/263e36984c81/native-mcp-first-turn-1505/assets/codex-x86_64-unknown-linux-musl /workspace/scratch/263e36984c81/Mikka-1505 /workspace/scratch/263e36984c81/native-mcp-first-turn-1505/results-01 /workspace/scratch/263e36984c81/native-mcp-first-turn-1505/assets/official-models-0.166.0.json

results-01 must not already exist. Preserve stdout/stderr from the commands.
If download, native launch, mock transport, or code-mode startup is incompatible,
retain that concrete failure and fix only the fixture boundary actually shown
to be wrong. Do not change required/grace/permissions/model metadata speculatively.

## Review status

Prepared offline by web_wait_review. Its exec tool returned
"No usable execution environment is available"; it has NOT run or syntax-checked
this file. Root has the authorized functioning host and will review/run it.
The pre-existing root binary verification is the only actual execution described
above. No VM was created by this task.
