# Feature switches live in PostHog

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「所有功能开关必须走 PostHog feature flag」. The coordinator set the scope: secrets, URLs and numeric settings are not switches; the three BYOS route switches (`MIKKA_BYOS_ENABLED`, `MIKKA_BYOS_CLAUDE_OAUTH`, `MIKKA_BYOS_CODEX_OAUTH`) are moved separately; when PostHog cannot be reached a switch keeps its present default.
- Rule: —
- Replaces: —

A deployment-wide feature switch is a PostHog feature flag, evaluated against
one fixed distinct id, `mikka-deployment`, never against a person or team
(`lib/deployment-switches.ts`, which lists them all). A switch reads PostHog's
explicit answer; while PostHog gives none (unreachable, still loading, or the
flag not created yet) it reads the environment variable that used to decide
it, and without that its default.

- A feature that ships on has a kill flag ending in `-off`: true turns it off,
  so a flag created inactive never turns a shipped feature off.
- A feature that ships off has a gate flag: true turns it on.
- The old environment variables are read only as that fallback. They can be
  removed from a deployment once its flag exists in PostHog with the same
  value.
- A workflow body never reads a switch: a step reads it and passes the value
  in, so a replay sees the same value.

Per-person flags (`mikka-proactive-profile`, the gated and kill switches in
`lib/feature-flags.ts`) are unchanged.
