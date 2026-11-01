# Agents reach the open internet by default

- Date: 2026-11-01
- Source: Alex, in the MVP acceptance session: 「域名完全开放，不允许你设白名单，黑名单。可以设，但是必须是手动去设」 and 「沙箱里面的必须是完全无限制的访问外网」
- Rule: —
- Replaces: the `network: "ask"` default for device runs (only cloud runs defaulted to `allow`)

A run's sandbox reaches any internet destination unless a person restricts it.
The default network permission is `allow` on every device, local and cloud,
so the run's domain list is `*`. Mikka never adds an allow list or a block
list by itself.

A person can still restrict it by hand: network `ask` or `deny` chosen in
settings, and an allow list saved on a workspace, team or project, keep
applying exactly as they do today.
