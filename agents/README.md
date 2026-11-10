# Agent definitions

Mikka's built-in Bot definition is `default/agent.json`. Bots chat on Mikka's AI SDK and Workflow loop and dispatch coding work to Claude Code, Codex or Cursor. The deprecated native Coordinator path stays disabled. Definitions do not contain executable JavaScript and do not grant account or workspace permissions.

The `research-example` directory demonstrates a file-backed definition with Markdown instructions and a lazily loaded Skill. It is an example, not an automatically activated Bot. Users still create a generic Bot with only a name and avatar.

```sh
pnpm exec tsx scripts/agent-kit.mts validate agents/default
pnpm exec tsx scripts/agent-kit.mts validate agents/research-example
pnpm exec tsx scripts/agent-kit.mts export agents/research-example > agent.json
pnpm exec tsx scripts/agent-kit.mts fixture-eval agents/default
pnpm test:agent-kit
```

`instructionsFile` and a Skill's `bodyFile` are developer/build-time file references. The loader confines reads to that directory, rejects traversal and symlink escapes, and produces the same strict materialized schema stored in PostgreSQL. The HTTP import accepts only the exported, checksummed materialized document; it never reads paths, imports modules or evaluates code.

Instructions add guidance below Mikka's host policy. Tools select entries from the shared registered catalog; each tool retains its live actor, lease, ownership and account-approval checks. Skill descriptions enter the prompt, while `load_skill` reads only the body assigned to the current execution snapshot. Hooks are registered host implementations, not user callbacks.

Fixture evaluation exercises the runner with synthetic outputs. It does not measure a model's performance and can never approve an improvement. See `docs/design/agent-as-code.md` for the deployment gate, HTTP contract, evaluation semantics and rollout limits.


New scopes use the built-in core definition plus computer tools when `cloudComputerRunsEnabled()` is true. It combines the cloud-computer kill switch and the edition-aware BYOS switch in `lib/deployment-switches.ts`. In the cloud edition, the BYOS fallback requires `MIKKA_BYOS_ENABLED=1`; community mode enables BYOS by default. Gmail full reads remain in the core definition. The definition API and execution reservation resolve the same initial profile. The profile does not create a computer, subscription, provider or credential.

Stored definitions, including old built-ins and custom profiles, are not migrated or expanded by new defaults or host flags. To adopt a missing tool, the owner first reads the current active definition/version, preserves their own guidance/skills/tool choices, explicitly adds the selected registered tools, then submits the existing same-origin `POST` command `{action:"save", definition, expectedVersion, requestId}`. This creates a new immutable version and activation record using the normal compare-and-swap check. Existing execution snapshots retain their original `effectiveTools`; subsequent executions use the selected new version. An unavailable computer capability still fails closed. There is no automatic reset, upgrade, inference or evaluation in this process.
