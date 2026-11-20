# Model acceptance uses the LiteLLM HTTP boundary

- Date: 2026-11-20 18:55 UTC
- Source: Alex, [#2891](https://github.com/alexj11324/Mikka/issues/2891) and [#2884](https://github.com/alexj11324/Mikka/issues/2884).
- Status: accepted; implementation and execution evidence are tracked on #2884 and #2891.
- Supersedes: live Claude Code, Codex and DeepSeek inference as development, CI or merge acceptance requirements in `AGENTS.md` and older acceptance guides. The routing requirement in [2026-11-20-0530](2026-11-20-0530-litellm-only-model-egress.md) remains in force.

## Decision

Development and acceptance use scripted model responses or previously recorded streams. No test, local-loop, nightly journey or acceptance run sends a real model prompt or requires a real model key or CLI login. Databases remain real, isolated PostgreSQL 17 instances on loopback with names ending in `_e2e`; do not create Neon branches or paid resources.

The model substitute implements the HTTP protocols used at `MIKKA_LITELLM_URL`. Application model admission, quota reservation and settlement, authorization, tool execution, durable workflows and daemon behavior continue through their normal code. Provider SDK or application modules are not replaced to manufacture an outcome.

Script matching uses a configured model alias and request features. An unmatched request fails with a specific 4xx response. Required cases cover streamed text, tool calls, timeout cancellation, 429, upstream 5xx and correlated usage/cost receipts. The local development and MVP drivers share this boundary; the retired gateway substitute must not remain as a second model implementation.

Recorded fixtures come from existing exported run records. Their metadata identifies the CLI version, source date, harness and runtime. Scripted fixtures remain labelled scripted; neither kind proves live model behavior, a deployed model mapping or production acceptance.

## Evidence

Every acceptance report names the immutable source revision, isolated environment, commands, results and substituted boundaries. A failed or unexecuted item remains unverified. CI and local-loop use the default scripted mode; a future explicitly authorized manual live check is separate from these gates.
