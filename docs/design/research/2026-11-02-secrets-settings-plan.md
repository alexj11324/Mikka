# 设置里的密钥与网站登录：方案（只出方案，未写代码）

基线：main `ffeb5b1`（#1056）。

- Devin 调研：[`2026-11-02-devin-secrets.md`](2026-11-02-devin-secrets.md)
- 设计稿：Figma https://www.figma.com/design/kVQC1aa6P0tPI1SQ0PjC6V （页「密钥与登录 v1」，10 屏 + 说明）；同样的稿子在 [`assets/secrets/`](assets/secrets/)（`screens.html` 和 `01.png`…`11.png`）
- 顺序：先调研，再画稿，最后才是数据模型和拆 PR（Alex 定的）。§2 按调研结果改过。

## 1. 现状核实

### 1.1 设置里能不能看到密钥页
- `lib/settings-sections.ts:46`：`secrets`（工作区组，「密钥与环境」）是 `adminOnly`；没有放进 `TEAM_ONLY_SECTIONS`，所以个人工作区和团队工作区的**管理员**都能看到，**成员看不到**。
- 生产（Vercel `mikka` 项目）`WORKSPACE_SECRETS_KEY` 在 production / preview / development 三个环境都有（只看了名字，没读值），所以管理员在生产上能存。
- 但「密钥与环境」只能存**工作区 / 仓库**范围的 key-value，没有个人范围。
- 账号组里有个「登录与密钥」（`logins`，`components/settings/saved-logins-settings.tsx`），**名字里有“密钥”，页面里只有网站登录，没有任何密钥**。Alex 在账号组里找“我的密钥”，打开这一页就只看到网站登录，看起来就是“还没做”。这是 Alex 第 1 条反馈最可能的原因。
- 成员能写仓库范围密钥（`lib/secrets/permissions.ts:14-25`），但页面是 adminOnly，所以成员没有入口：这就是 `docs/design/information-architecture.md` 里已登记的 M6 / G8（P2，未修）。

### 1.2 网站登录“返回到 Bot”
- `components/settings/saved-logins-settings.tsx:52`：没有登录时显示一个按钮「在对话里添加登录」（`Settings.logins.add`），它是 `<Link href="/">`，也就是回首页，首页就是 Bot 聊天。设置里没有添加表单。
- 根本原因在服务端：保存只有一条路，`lib/credentials/route.ts` 的 `browserCredentialRoute`，要先用 `challenge` 拿到一次性 nonce，并且要有一个绑定 bot / run / subagent 的**活浏览器**（`resolveCredentialBrowser`），站点由那个浏览器当前的页面决定。设置里没有浏览器，所以现在没法保存。
- 已有的管理能力：列表、使用记录、删除（`savedLoginsRoute` / `deleteSavedLogin`）。不能改密码，不能从设置里新建。
- 开关：`credentialVault` = PostHog `mikka-credential-vault-off`（kill）。PostHog 里**还没有建这个 flag**，所以它读旧的 `CREDENTIAL_VAULT_ENABLED`；没有设置的话默认开着。

### 1.3 密钥怎么进入运行
- 只在一个地方注入：设备认领运行时（`app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts` → `taskSecretInjection`）：工作区范围 + 仓库范围（仓库要匹配 run 的 GitHub remote），并用 `runSecretMasker` 把输出里的值遮住（`kind=env` 的不遮）。
- 认领路由已经检查了 `run.userId === caller.userId`，所以个人密钥可以按 `run.userId` 加载，这里就是挂个人密钥的地方。

## 2. 信息架构（看了 Devin 之后改的）

**一个页面「密钥与登录」，顶部切换「我的 / 〈工作区名〉」**，和 Devin 的「Secrets for」一样。侧栏里的「账号 › 密钥与登录」（`logins`）和「工作区 › 密钥与环境」（`secrets`）都打开这一页，只是默认停在不同的一侧，侧栏高亮跟着切换走。原来的 `?section=secrets` 链接不会失效。

| 一侧 | 内容 | 谁能看 / 改 |
| --- | --- | --- |
| 我的 | 我的密钥和我的网站登录；筛选：全部 / 密钥 / 网站登录 | 只有本人；管理员也看不到（Devin 原文：“not visible to other organization members or admins”） |
| 工作区 | 工作区范围和仓库范围的密钥；筛选：全部 / 工作区 / 仓库 | 成员能看元数据，能写仓库范围；工作区那几行显示 🔒（现有权限矩阵）；管理员全部 |

- **新建 Sheet**：范围（仅我 / 工作区，成员看到的是 仅我 / 仓库）、类型、名称、值（👁 只用来看自己正在输的内容）、说明、更多控制。非管理员默认「仅我」；存到工作区前要确认一次「〈工作区〉的所有成员都能用 X？」（Devin 2026-09-11 的 Safer Secret Defaults）。
- **类型只有两个**：「密钥」和「网站登录」。原来的「环境变量」不再是一个类型，改成更多控制里的「在输出里遮住」开关（Devin 的 `is_sensitive` / Redact）：开 = 原来的 `secret`，关 = 原来的 `env`。不做 TOTP 单独类型和 Cookie 类型（理由见调研 §6）。
- **表格列**：我的一侧是 名称 / 类型 / 说明 / 最近使用 / 更新时间 / ⋯；工作区一侧是 名称 / 类型 / 范围 / 说明 / 更新者 / 更新时间 / ⋯。
- **批量添加**：粘贴 .env 或拖入文件（≤ 2 MB），按行显示 新建 / 替换 / 错误；保留名称跳过；有一个「已有同名时替换」开关。
- **网站登录**：只能选「仅我」（密码箱属于个人）。编辑时网站和账号不能改，只能改密码、两步验证和说明；⋯ 里有使用记录。
- **不做**：Service users（Mikka 没有这个概念）；MCP 和插件密钥继续放在各自的页面（Devin 2026-09-16 也是这么改的）。

## 3. 数据模型

### 3.1 个人 key-value：新表 `user_secrets`（不复用 `workspace_secrets`）
```
user_secrets(id uuid pk, userId text → user(id) ON DELETE CASCADE, name text, kind 'secret'|'env',
  note text NOT NULL DEFAULT '', ciphertext, iv, keyVersion, createdAt, updatedAt,
  UNIQUE(userId, name))
```
- 和 `user_e2b_keys` 一样是账号级，没有 workspaceId：一个人的密钥跟着他进每个工作区，只进**他自己的 run**（`run.userId = userId`），永远不进其他成员的 bot / run。这和 2026-11-01-2240「自己的凭据永远自己能用」一致，没有管理员开关。
- 加密用现有的 `sealSecret`（`WORKSPACE_SECRETS_KEY`），AAD 绑 `userId + id + name`，这样一行密文搬到别人名下也解不开。
- 同名优先级：**个人 > 仓库 > 工作区**（自己的值覆盖团队默认）。run 事件里只记名字和来源，不记值。⚠ 要 Alex 确认。
- 删账号：FK 级联删掉（`lib/account/delete.ts` 的清理测试会列出这张表）。

### 3.2 工作区密钥：只加列，向后兼容
- `workspace_secrets` 加 `note text NOT NULL DEFAULT ''`（新增列，有默认值，现有行和现有代码不受影响）。
- `WorkspaceSecretView` 增加 `note`、`updatedBy`（显示名）、`updatedAt`，都是元数据（#436 当时去掉了时间戳；表格要这两列，属于 Alex 要的 Devin 列，PR 里写明这一点）。

### 3.3 网站登录：保留 `lib/credentials` 的 KMS 方案，不并表
- 它和 key-value 密钥不是一回事：用 AWS KMS 信封加密、leak HMAC、站点绑定，由 broker 填进浏览器，模型永远看不到；而 key-value 是用 `WORKSPACE_SECRETS_KEY` 加密的环境变量。并到一张表里，要么削弱登录的保护，要么把 KMS 套到所有环境变量上，两头都不划算。
- 设置里加的是**管理入口**：新建、改密码、删除、使用记录，外加「每次使用前问我」。
- 新的服务端路径 `CredentialStore.saveDirect(actor, {origin, username, password, totpSeed?})`：不需要浏览器 nonce，因为 nonce 防的是“页面伪造登录卡”，在设置里是本人自己输入站点。`origin` 走现有的 `canonicalOrigin`（只允许 https），owner 取自会话，客户端不传 userId。现有的 `UNIQUE(user_id, origin, username)` 照用；同站同账号就是替换。
- 「每次使用前问我」直接用已有的 `credentials.unattended_allowed` 列，不需要迁移。
- 两步验证密钥：`totp_mode` 已经有 `'stored'`，但 `credential_secrets` 只存了一份密文，要加一份 TOTP 种子的密文（迁移只加列）。放到最后一个 PR，可以先不做。

## 4. 安全
- **只写不读**：服务端不返回任何值、密文、last4。「👁 显示」只在输入的时候能看到自己正在输的内容；保存后只能替换。
- **Redact**：Mikka 的值本来就不显示，所以 Devin 的“在表格里隐藏值”在这里没有意义。对应的是“在运行输出里遮住”，也就是现有的 密钥 / 环境变量 两种类型（密钥遮、环境变量不遮）。不再另加一个开关，免得两个设置管同一件事。
- **使用前审批**：网站登录做（broker 填之前问，复用 `unattended_allowed`）。key-value 是在 run 开始时一次性注入的，“每次使用”其实是“每次 run 前问”，要让 run 卡在 needs_you；这个先不做，⚠ 问 Alex 要不要。
- **日志**：沿用 `logSecretFailure`（只有 id 和错误码）和 `guardSecretsDb`（数据库错误里有参数，所以把它换掉）。`runSecretMasker` 要把 run 主人的个人密钥也加进去。在 `tests/secret-masking.db.test.ts` 里加个人密钥的用例。
- **审计**：工作区写入继续在同一个事务里 `recordAudit`（写审计失败就回滚）。个人密钥**不进**团队审计日志（管理员不该看到成员个人密钥的名字）；它的写入和使用记在本人的「使用记录」里（和网站登录一样）。
- **权限在服务端**：`secretActionAllowed` 和 owner 判断都在 store 里做；UI 只用来决定显示哪些按钮。
- **批量 .env**：浏览器用 FileReader 读文件（不上传存储），≤ 2 MB，`KEY=value # note`，支持引号。服务端用同一个解析函数再解析一遍，单个事务写入；保留名称（`isReservedEnvName`）跳过；同名可选“替换 / 跳过”；预览只显示名字，值用圆点；行数上限 `WORKSPACE_SECRETS_LIMIT`。

## 5. 开关（PostHog，`lib/deployment-switches.ts`）
- 新增 `personalSecrets: { flag: 'mikka-personal-secrets-off', kind: 'kill', fallback: true }`：默认开（AGENTS.md「Ship features on」），只作为出事时的 kill switch。没有 legacy 环境变量。
- 设置里新建网站登录继续用已有的 `credentialVault`。顺便在 PostHog 里把 `mikka-credential-vault-off` 建出来（inactive），这样就不再靠环境变量决定。
- 成员能看到「密钥与环境」是修 bug（M6），不加开关。

## 6. 拆成 4 个 PR
1. **网站登录在设置里管理**：`logins` 改名为「密钥与登录」，并做好顶部切换页面的框架；删掉 `href="/"` 那个按钮；添加 Sheet（类型 = 网站登录）、改密码、删除、⋯ 菜单、「每次使用前问我」；`CredentialStore.saveDirect` 和 server action。测试：`saveDirect` 的 owner 绑定和 origin 规范化（db test），一个浏览器用例（设置里新建 → 列表出现 → 删除）。**直接修掉 Alex 的第 2 条反馈。**
2. **工作区「密钥与环境」升级**：去掉 `adminOnly`（成员按权限矩阵）；表格列改成 名称 / 类型 / 范围 / 说明 / 更新者 / 更新时间 / ⋯；迁移 `note` 列；批量添加 .env。
3. **个人 key-value 密钥**：`user_secrets` 迁移和 store；在认领注入里加个人密钥，并决定优先级；加进 masker；「我的」那一侧显示密钥行；`personalSecrets` flag。测试：注入只给本人的 run（另一个成员的 run 拿不到），遮罩，删账号级联。
4. **（可选，等 Alex）** 两步验证种子存储；key-value 的 run 前审批。

每个 PR 都跑 typecheck、lint、相关单测，加上那一个浏览器用例（mikka_e2e）。

## 7. 要 Alex 拍板的（已经对照过 Devin，见调研 §11）
1. **同名优先级**：Devin 不覆盖，同名的第二个变成 `NAME_2`。我建议不照搬：新建时提示已有同名，确认后个人覆盖工作区。用哪种？
2. **密钥的“每次使用前问我”**：Devin 文档里没有这个功能。网站登录现在就做；密钥要不要做（会让 run 停下等人）？
3. **个人密钥给不给 Bot 自己的工具**：Devin 的 Agent 本身就会用密钥。先给 Agent run，Bot 的工具后面跟上，可以吗？
4. **入口**：已经改成一个页面加顶部切换（Alex 要的 Devin 样式），侧栏两个入口都打开这一页。可以吗？
5. **「环境变量」类型改成「在输出里遮住」开关**，可以吗？
