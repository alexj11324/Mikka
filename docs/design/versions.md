# Design versions: v11

The single current version of the Mikka interface, as of 2026-10-29. Read this
before opening Figma: it says which page is authoritative for each area, which
older pages were archived, and which frames are still waiting on Alex.

Figma file `zPe5LKycb2XuT1ivCLRw07`. An area's row names the one page (and the
frames) that count. Anything not listed here is either in `归档` or is a
component library with no demo frames.

## v11 by area

| # | Area | Authoritative page / frames | Status |
| --- | --- | --- | --- |
| 1 | Shell and the global AI sidebar | `237:4483`, frames `237:4484`, `237:4725`, `237:5014` | Current |
| 2 | Onboarding | `241:4483`, frames `241:4484`, `241:4889`, `241:5265`, `241:5641`, `247:5342` | Current |
| 3 | Thread discussion on an issue | `220:5022`, frames `220:5023`, `220:5199` | Accepted in `decisions.md` |
| 4 | Thread card and dispatch | `365:10368` frames `03a`, `03b`, `03c`, `03c-2`, `03d`; PR states in `355:4750` | Current |
| 5 | Group chat | `305:4750`, frames `A1`, `A2`, `A3` | 待批, not in `decisions.md` |
| 6 | 建议 | `365:10368` frames `08a`, `08b` | Current |
| 7 | Connect a computer and device approval | `346:4792`, frames `01`–`11` | 待 Alex 确认 |
| 8 | Stop a thread | `364:4869`, frame `372:4786` (running / stopping / timeout × light, dark, narrow) | 待 Alex 确认 |
| 9 | Thread output: artifact, Factory approval, Live Diff | `395:15023` (artifact placement and share `11a`–`11e`), `357:4750`, `497:4860` | 待 Alex 确认; Live Diff 待审核 |
| 10 | Settings | `551:6857` 设置 v4 · 全部接通 (V01–V15, N1–N6, S-A…S-Q); v3 `476:4860` kept as history | Current; every control maps to a real backend (see `docs/settings-backend/*.md`) |
| 11 | Mobile | `358:9186`, frames `01`–`22` | Current |

## Archived on 2026-10-29

Moved to the `归档` page (`177:1320`), one section per source page. The demo
frames moved; components used by current pages stayed in place so no instance
breaks.

| Archived | Section in `归档` | Replaced by |
| --- | --- | --- |
| `465:4860` 设置 · 菜单结构与布局 (S01–S12) | `545:26043` | `476:4860` 设置 v3 |
| `254:4581` 线程卡片初版 (A–D + ThreadCard) | `545:26753` | `365:10368` ThreadCard v3 and `355:4750` |
| `319:4750` 建议卡片 v2 demo frames (A–G) | `545:26754` | `365:10368` 08a / 08b |
| `268:4750` iOS 初稿 demo frames (00–08, 07a–07f) | `545:26755` | `358:9186` mobile completion |
| `305:4750` C1 设置偏好 | `545:26756` | `476:4860` 设置 v3 (the A1–A3 group-chat frames stay) |

Component library pages that remain (no demo frames):

- `319:4750` 组件库 · 建议卡片与登录卡
- `268:4750` 组件库 · 手机端

## Copy and visual violations found in v11 frames

Not published as part of the whole. Fix in place; do not redraw.

- `346:4792`: input field carries a stroke (R-31); `1安装` / `2登录` / `3上线`
  are missing the space; 「连接失败，请重试」 uses an imperative 请 (C-04); a
  stray copy block sits outside the frame at the top right.
- `476:4860`: 「请管理员增加」 uses an imperative 请 (C-04).
- `241:4483`: 「都连好了。先交给我一件事吧。」 is colloquial (C-02).

## What v11 is not

- It does not redraw any frame. Yesterday's Claude Code work is kept as-is.
- It does not change avatars. The multi-colour stacked group avatar follows
  Grok bot and is intentional.
- It does not settle any 待 Alex 确认 page; those stay as drawn until Alex
  accepts them.

## Settings v4 (2026-10-29)

Cloned from v3, then changed against a competitor review (Linear, Slack, Notion,
ChatGPT, Claude, Cursor, Devin, Copilot, Vercel, Raycast; Plane, Twenty, Open
WebUI, LibreChat, Lobe Chat, Dify, Cal.com):

- New sections: 个人 › 安全 (N1: password, Passkey, Google, 2FA, sessions),
  数据与隐私 (N2: export, shared links), 开发者 (N3: personal access tokens);
  工作区 › 权限与审批 (N4: computer use plus read/write per connected app),
  密钥与环境 (N5: secrets masked in output vs. environment variables, egress
  allowlist), 审计日志 (N6: admin only, 90 days, IP).
- Moved: 登录/登录设备 from 账户 to 安全; 导出/已共享链接 to 数据与隐私;
  电脑操作 from Bot to 权限与审批 (S-H rebased onto N4).
- Renamed: 已保存的登录 → 登录与密钥 (adds 我的密钥), 设备 → 我的电脑.
- 通知: channel × event pills (手机 / 邮件 / Telegram), 安静时段; the daily
  reminder count is a status line, not a section.
- States: S-O save failed (value restored + retry), S-P member view (admin-only
  sections hidden, fields read-only), S-Q loading (layout kept, placeholders).
- Every nav item works; nothing is marked 即将推出.
