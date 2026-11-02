# Secrets and website logins live in settings, on one page

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session (two messages, 2026-11-02) after reviewing the plan, the Devin research and the Figma file: 「同名按你的建议：新建时提示重名，确认后个人覆盖工作区」「所有密钥（包括网站登录）都不需要『使用前问我』，直接用」「个人密钥 Bot 自己的工具和 Agent run 都可以用」「一个页面加顶部切换，同意」
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
7. **Saved values can be seen and copied**, website-login passwords too. The
   list never carries a value; 👁 or 复制 asks the server for that one value,
   which checks access, records it (team audit for workspace secrets, the
   person's own use history for theirs) and limits how often. Replaces
   「只写不读」 (#436 design update). How a login password is opened without
   giving the main app KMS decrypt is in the plan, § 10.

Design: Figma `kVQC1aa6P0tPI1SQ0PjC6V`, pages 「密钥与登录 v1」 and 「密钥与登录 v2」 (👁 and 复制 on each row) (proposal, not yet
accepted as a layout source). Research:
[`../research/2026-11-02-devin-secrets.md`](../research/2026-11-02-devin-secrets.md).
