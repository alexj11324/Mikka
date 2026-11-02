# Extra usage does not disable a subscription

- Date: 2026-11-02
- Source: Alex, in the subscription repair session: 「额外用量开启，这和我们的订阅有什么关系吗？……只要使用订阅，只要是能用就可以用啊」
- Rule: —
- Replaces: the implementation's requirement that Codex credits and Claude extra usage be explicitly disabled before any subscription use.

Bot chats and Agent runs can use a connected, enabled subscription while its
plan allowance is available. Codex credits and Claude's extra-usage preference
do not disable it, whether those fields are enabled, disabled or absent.
Settings must not label the subscription unused for that reason or ask the
person to turn off extra usage. Keep actual quota, sign-in, ownership and pause
checks, and preserve the selected credential for each run.
