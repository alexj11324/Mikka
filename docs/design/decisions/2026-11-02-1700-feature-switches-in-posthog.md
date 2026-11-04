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

## Group contribution policy rollback

`mikka-group-contribution-off` follows this owner as a Boolean kill flag.
False (including an inactive flag) selects `group-contribution-v1`; true
selects the reviewed forced-reply baseline, `group-route-v0`. Both policies
use the same sequential Decision protocol and authorization boundaries.
There is no automatic policy promotion or user-facing policy override.

While PostHog gives no explicit answer, `MIKKA_GROUP_DECISION_POLICY` can
select either recognized version; otherwise the candidate remains enabled.
The existing deployment cache refreshes at most once per 60 seconds, so a
manual flag change affects subsequent routing attempts after refresh. Each
attempt freezes one version before its first provider request, records it
on every retained routing step, and preserves earlier attempt versions on
retry. A change cannot mix policies within an in-flight routing chain.

The authenticated fixed-dataset replay endpoint passes its host-selected
baseline or candidate explicitly and does not consume the live flag. Its
collector reports completion of all logical cases separately from quality
acceptance; an uncertain or invalid receipted result remains a failure and
retains its known or unknown cost. Rollback and restoration are manual,
reviewed operations; a full collection is not an automatic rollout gate.
