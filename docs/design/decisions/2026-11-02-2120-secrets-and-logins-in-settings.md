# Secrets and website logins live in settings, on one page

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session (three messages, 2026-11-02) after reviewing the plan, the Devin research and the Figma file: 「同名按你的建议：新建时提示重名，确认后个人覆盖工作区」「所有密钥（包括网站登录）都不需要『使用前问我』，直接用」「个人密钥 Bot 自己的工具和 Agent run 都可以用」「一个页面加顶部切换，同意」
- Rule: —
- Replaces: the sidebar name 登录与密钥 (decisions.md, 2026-10-30 Settings v4 row); saved logins added only from chat

1. **One page.** Settings › 密钥与登录 (`logins`) holds the person's own
   secrets and website logins. A switch at the top changes between 我的 and the
   current workspace (Devin's 「Secrets for」). 工作区 › 密钥与环境 opens the
   same page on the workspace side.
2. **Logins are added in settings.** A website login can be added, given a
   new password and deleted from settings; a Bot asking in chat is no longer
   the only way in. Its 添加 never leaves settings.
3. **No 「使用前问我」.** No secret and no website login asks before each use;
   there is no such switch. The existing `credentials.unattended_allowed`
   column keeps its default (`true`).
4. **Same name.** Adding a personal secret whose name a workspace secret
   already has asks once; after that the personal value wins in that person's
   runs and Bot tools.
5. **Where personal secrets go.** A personal secret reaches its owner's own
   Agent runs and their own Bots' tools, never another member's.
6. **No 环境变量 type.** It becomes the 「在输出里遮住」 switch, on by default
   (Alex: 「同意…默认打开」).
7. **Write-only, as in Devin.** A saved secret or website-login password can
   be used, replaced and deleted, never viewed or copied; no endpoint returns a
   value. (Alex first asked for view and copy, then withdrew it the same day.)

Design: Figma `kVQC1aa6P0tPI1SQ0PjC6V`, page 「密钥与登录 v3」 (v1 and v2 are 已废弃) (proposal, not yet
accepted as a layout source). Historical research, retained at its recorded repository revision:
[Devin secrets comparison](https://github.com/alexj11324/Mikka/blob/bf633a2e86e5e8dad3b5b16adc28afd286583482/docs/design/research/2026-11-02-devin-secrets.md).
