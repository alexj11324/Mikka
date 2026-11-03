# Official-subscription cloud routing — 2026-11-03

The user explicitly requested a new real-provider check with their existing application's connected Codex and Claude subscriptions. This is a separate authorized scope from the prior DeepSeek Flash/API-key acceptance; no global test-model policy was changed and no API-key fallback was allowed.

Production revision `e5f95f68b78afc153156af031d99fba97a074b39`, deployment `dpl_GtrdcBtz5BBoExjaDtaLvF3FVcSQ`, actual parent worker digest `69673aa579c9242bbb0446dda8ca178c209dfd32` were fixed before prompts. Normal email sign-in reused the dedicated Test Account Vault in process memory. The existing account's connected subscriptions were refreshed. Two isolated test Bots were created in its existing workspace; existing Bots, their model selections, subscription connections and model priorities were preserved. No credentials were reconnected, copied or written to an environment file.

## Actual failures before execution

- Claude Bot `3478763d-eaac-4a92-af9d-0cff7fb27c0c`: actual subscribed chat model `claude-haiku-5-5`, selected execution priority `claude-opus-5-5` / `claude_code`. Marker `c3f72167-claude` created application issue `dc2a1d60-f7ed-4a05-8c02-fc7d1fe88de1`. The Bot chose `dispatch_run` without a repository, received `repositoryRequired` and asked for a GitHub repository, contrary to the standalone-file request. No Factory run/native task session started.
- Codex Bot `13157e4a-4527-41f2-9326-58f15e36b199`: actual subscribed chat model and execution priority `gpt-5.6-luna` / `codex`. Marker `c3f72167-codex` created issue `78ce76cf-776f-4ac2-9885-82966e746237`, then used `intake_factory_request` / `dispatch_factory_task`. The repository-bound dispatch returned `agentRepoMissing`. Factory task `1880a06a-1af1-4263-9d3b-c01ee91acf53` remained execute/pending without a run or session.

Both subscribed Bot chats finished idle with no auth error; this does not establish subscribed Agent execution. Their real failed replies remain in history. Before code changed, the pending Codex task was cancelled through its normal revision-bound owner API, both chats were observed idle and owned parent `izerdqsjkbs7telhga4ab` was paused. The protected Acme sandbox was not connected to or mutated. No failed outcome was changed into a pass.

Occurrence 7 × impact 7 = **49**: the same plain-file cloud request failed through two real subscription providers. [Issue #1124](https://github.com/alexj11324/Mikka/issues/1124) tracks the new failure and acceptance.

## Root cause and narrow change

The normal frozen built-in definitions actually include the computer tools; missing tool grants are not the explanation. The instructions nevertheless said all non-screen work goes to `dispatch_run`, whose first-thread path requires a repository. They separately said an explicit Bot-computer request uses `dispatch_bot_computer`. The hosted tool repeated the unconditional non-screen rule, while the low-level Factory dispatch description did not distinguish its registered-device-repository requirement from hosted thread provisioning.

Make those paths explicit and consistent: standalone files/reports without repositories use the existing hosted computer dispatch even without screen interaction; an explicitly requested Bot computer takes precedence. Normal dispatch already routes through Factory, so mentioning Factory does not require a model to choose a low-level repository-bound dispatch. Repository-backed work retains its existing path. No schema, runtime placement, credential, ownership, Factory or owner-acceptance gate changes.

## Verification boundary

The new recorded-model scenario failed against the previous prompt, then passed after the change. It exercises both harness inputs through the real tool registry/schema and confirms they reach hosted dispatch without invented repository/device IDs. Its prompt/tool-contract assertions guard the contradictory guidance. It is deterministic coverage, not proof of a real model's tool choice.

Local checks after the change: all 42 routing/tool/default-capability tests pass; application typecheck, targeted lint and `git diff --check` pass. Preflight also ran 16 thread/continuation/startup regressions and 92 daemon/subscription/native/worktree regressions successfully, including finite redacted startup diagnostics, model-report refusal and hung-initializer cleanup. Those deterministic native fixtures do not establish provider acceptance.

After required CI and deployment, fresh real official-subscription tasks must demonstrate execution, independent review/verification, verifier-worktree/Git bytes, normal owner acceptance, result delivery to an idle Bot and continuation with its frozen nonempty model/account. Production acceptance is pending for this patch until those results are recorded; the previous Flash acceptance cannot substitute for it.
