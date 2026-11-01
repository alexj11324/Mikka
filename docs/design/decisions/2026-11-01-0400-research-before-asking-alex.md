# Research how leading products do it before asking Alex

- Date: 2026-11-01
- Source: Alex: 「所有的问题，在问我之前，必须去调研其他大厂产品。如果有这个答案，就不要再问我了」
- Rule: —

## Rule

1. Before a session asks Alex to choose, it looks at how leading products
   solve the same problem (for example Linear, Slack, GitHub, Figma, Notion,
   Vercel, Stripe, Claude, ChatGPT, Cursor, Devin, Codex). Product docs,
   public changelogs and the products themselves count.
2. When they agree, follow them and do not ask. Write the choice and the
   products it follows into the PR description or a decision file.
3. Ask Alex only when the products disagree, when the choice depends on
   Mikka's own strategy, money or brand, or when it reverses one of his
   decisions. The question names what each product does and recommends one
   option.
4. Rules already written in `docs/design/decisions/` still apply; research
   does not override a decision Alex made. Check them first. Example: cloud
   runs use only the person's own E2B API key; without one, runs go to their
   own computer or server. That is Alex's decision, whatever other products
   do by default.

## Applied on 2026-11-01

| Question | Products | Choice |
| --- | --- | --- |
| Per-tool approval for plugin write actions | Claude connectors, ChatGPT apps | Write tools get allow / ask / deny; read tools run |
| Concurrent hosted model calls in one workspace | every hosted model product | Allowed, with per-call budget holds and a concurrency cap |
| Data freshness when a window regains focus | Linear, Slack, GitHub, Vercel | Push first; stale-while-revalidate; never hide content; no third-party checks on focus |
| Internal terms such as "daemon" in UI copy | Cursor, Linear | Not shown; use the user-facing name |
