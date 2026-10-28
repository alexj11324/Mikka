# Agent definitions

Mikka's built-in Bot definition is `default/agent.json`. The model loop remains in the selected AI SDK, Claude Code or Codex harness. Definitions do not contain executable JavaScript and do not grant account or workspace permissions.

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
