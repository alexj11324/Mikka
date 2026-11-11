# Use the authorized 2023 account for the owned Codex Cloud MCP case

- Date: 2026-11-11
- Source: Alex, issue #1918 implementation conversation: 「你可以使用这个 GPT 6 Luna」 and 「你可以使用我们的 20232024 账户，它有 GitHub 授权，也有 GPT 的订阅连接」.
- Rule: —
- Replaces: —; this is an issue-specific exception to the default shared SMOKE acceptance identity.

The Cloud Task native MCP acceptance may sign in as the existing
`alexjiang20232024@gmail.com` account and use its own official Codex
`gpt-6-luna` subscription. The driver verifies the exact account, its personal
workspace and the frozen execution identity's owned subscription and cloud
runtime through normal APIs.

Use the existing Infisical `prod:/` `ALEX_TEST_EMAIL` / `ALEX_TEST_PASSWORD`
pair, mapped only in the child process environment to
`MIKKA_TEST_ACCOUNT_EMAIL` / `MIKKA_TEST_ACCOUNT_PASSWORD`. Preserve existing
credentials and settings. The case has its own fixture journal and report;
its temporary MCP connection, Profile and task stay under that account.

The shared SMOKE identity remains the default. Its existing Claude case keeps
its bound subscription and records its actual quota result. This Codex case
provides one independent subscription result. Full candidate-template
publication retains both official subscription gates, original-file
conservation, authenticated bootstrap evidence and source/worker pins.
