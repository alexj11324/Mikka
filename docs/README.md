# Mikka documentation

Use this index to find the setup, design, integration and operations documents
for the part of Mikka you are changing. Development and acceptance rules live in
[`AGENTS.md`](../AGENTS.md) and [the contribution guide](../CONTRIBUTING.md).

## Set up and contribute

- [Development workflow](dev-workflow.md) covers issue ownership, local work,
  pull requests, merging and release follow-through.
- [Cloud Linux bootstrap](local-bootstrap.md) prepares the isolated database,
  dependencies and development tools.
- [Local runtime](local-runtime.md) starts the application and daemon and
  describes the API/CLI acceptance driver.
- [Cloud development access](cloud-preview.md) explains access to an
  application running inside a cloud development environment.
- [Dependency-aware CI](ci/incremental.md) explains affected checks, fallback
  coverage and required gates.
- [Workflow reference](../.github/workflows/README.md) maps CI and release jobs.
- [Test ownership and CI cost](ci/test-ownership.md) explains regression
  ownership, consolidation evidence and CI performance measurements.

## Understand the product and design

- [Design entry point](design/README.md) defines source priority and which
  document owns each kind of rule.
- [Glossary](design/glossary.md) defines bots, chats, threads and Agents.
- [Rules](design/rules.md), [components](design/components.md) and
  [copy](design/copy.md) guide product and UI changes.
- [Decision records](design/decisions/README.md) explain how to record or
  supersede a decision. [Earlier decisions](design/decisions.md) remain frozen
  history with the authority described by that guide.
- [Feature specification template](design/spec-template.md) supplies the
  structure for a feature specification.
- [Execution rules](execution-rules.md) describe model and machine selection.
- [Settings](settings.md) maps personal and workspace settings.

## Connect and run Mikka

- [Self-hosting](self-hosting.md) deploys the public server and connects clients.
- [Self-hosted model credentials](self-hosting-byok.md),
  [realtime](self-hosting-realtime.md) and
  [GitHub cloud connection](self-hosting-github-cloud.md) cover their setup.
- [MCP](mcp.md) connects external agents and documents the available tools.
- [GitHub App setup](github-app-manifest.md), [Telegram](telegram.md),
  [Slack](slack-bot.md) and [Linear sync](linear-sync.md) cover integrations.
- [Desktop](../apps/desktop/README.md) covers the Electron client.
- [Mobile](../apps/mobile/README.md) covers the Expo client.

## Verify and operate

- [Acceptance](acceptance.md) defines required evidence, identities and cleanup.
- [Isolated test accounts](test-accounts.md) describes the loopback account pool
  and its application, database and lease boundaries.
- [UI review checklist](review-checklist.md) applies before presenting UI.
- [Shared web and desktop runtime](operations/web-runtime.md) documents build
  outputs, startup and rollback.
- [Web deployment](operations/web-deploy.md) covers production publication.
- [Production smoke](production-smoke.md) describes the automatic deployed check.
- [Tracing](operations/tracing.md) locates requests and database queries.
- [Infisical Cloud](infisical-cloud.md) describes existing credential delivery.

- [Inbox API](inbox-api.md) defines pending, snoozed and completed items, actions, permissions and live refresh.

## Update documentation

[2026-11-08 全仓审校记录](audits/2026-11-08-documentation-refresh.md)列出本次覆盖的
每一份文档、修改范围和验证边界。

Use [`update-docs`](../.claude/skills/update-docs/SKILL.md) to discover affected
pages and [`technical-documentation`](../.claude/skills/technical-documentation/SKILL.md)
to verify facts and improve writing. Use
[`writing-for-agents`](../.claude/skills/writing-for-agents/SKILL.md) for Agent
instructions. Sources, pinned revisions and licenses are listed in the
[project skill registry](../.claude/skills/README.md).

Check each changed command, path and behavior against the implementation and
the applicable accepted decisions. Keep related README sections aligned and
link to the document that owns a topic. Historical reports under `acceptance/`,
`integration/`, `reviews/` and evidence folders describe their recorded revision
and environment. Preserve their results when updating current operating guides.
