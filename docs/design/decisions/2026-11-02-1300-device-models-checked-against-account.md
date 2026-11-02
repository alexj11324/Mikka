# A device's models are checked against the account that runs them

- Date: 2026-11-02
- Source: the coordinator session, deciding for Alex on the model probe (#963): 「按 A 做。证据充分，ADR 0009 成立。」 Probe without a login; device + Agent list = probe ∩ the catalogue of the subscription that would run it; without one, the probe list marked 「未与账号核对」; never read `~/.codex` or `~/.claude`.
- Rule: —
- Replaces: —

The daemon asks each CLI for its models in a throwaway home with no login
(`packages/daemon/src/model-probe.ts`). That answer is what this CLI version
can drive, not what an account may use. Evidence, from the pinned binaries:

- Claude Code 2.1.309 fetches `{base}/api/claude_cli/bootstrap` with the
  account's auth headers at startup and merges its `additional_model_options`
  into the model options; its initialize schema also names
  `unavailable_models`, "Models the account can see but not select … e.g. a
  model the org's Zero Data Retention setting excludes".
- Codex 0.163.0's models manager (`models-manager/src/manager.rs`) keeps
  `remote_models` refreshed through its `auth_manager` into
  `models_cache.json` ("failed to refresh available models"); without a login
  it falls back to the "bundled models.json".

A run on a device never uses the device's own login: its credential comes
only from Mikka (the bot owner's subscription, a member's share, or an API
key), and each run's CLI home is its own (ADR 0009;
`packages/daemon/src/agents/harness-home.ts`). Reading the person's login to
probe would break that and report the wrong account. Mikka already reads the
account's own catalogue with that account's login
(`packages/subscription-worker/models.go`, the same endpoints the CLIs
refresh from).

So, in 「Bot 与 Agents」, a device's models for an Agent are the ones its CLI
reported that the connected account of that Agent's provider also lists (a
reported slot counts by its id or the model it resolves to); the CLI's own
default stays the default only when it is among them.

- No connected account for that provider: the CLI's list as reported, with
  the list headed 未与账号核对.
- Nothing in common: nothing is offered (还没有可用模型).
- Mikka Cloud is unchanged: it offers the connected accounts' catalogues.
