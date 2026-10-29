# 设置 › 个人 › 账户：后端接口

UI 接线参考。所有 server action 都在 `app/actions/account.ts`，返回 `ActionResult<T>`（`lib/action-result.ts`）：成功时是数据对象，失败时是 `{ error: ActionErrorCode, params? }`，用 `Errors.<code>` 显示文案（`messages/*.json`）。

通用约定：

- **权限**：每个 action 都先从 cookie 会话读当前用户（`auth.api.getSession`），不接受客户端传的 userId。没有会话一律返回 `authRequired`，且不做任何改动。
- **非预期错误**（数据库挂了、Better Auth 返回未知错误）不转成错误码，直接抛出，按页面现有的通用失败处理。
- 时间字段都是 ISO 8601 字符串（UTC）。

## 头像「更换」

```ts
uploadAvatar(form: FormData): Promise<ActionResult<{ image: string }>>
```

- 入参：`FormData`，文件放在 `avatar` 字段。客户端先缩到 ≤256px 再上传。
- 校验（服务端）：声明的类型必须是 `image/png`、`image/jpeg`、`image/webp`，且文件头签名与声明一致（SVG 或改了扩展名的文件都拒绝）；大小 ≤ 200 KB。
- 返回：`image` 是新的 `user.image`，形如 `/api/avatars/<userId>/<sha256>`。显示时照旧走 `avatarImageSrc()`（`lib/default-avatar.ts`，已支持这类路径，会加 base path）。iOS 端 `Avatar` 组件对 `/` 开头的路径会拼 `API_URL`，无需改动。
- 错误码：`avatarInvalidType`（类型不对、不是文件、空文件）、`avatarTooLarge`、`authRequired`。
- 副作用：写 `user_avatars`（每人一行，覆盖旧的），更新 Better Auth `user.image`。旧图的 URL 立即 404；配置了 R2 时旧对象尽力删除。
- 存储方式与理由：仓库已有 R2（`lib/artifacts/storage.ts`，私有 artifacts 桶），头像存到 `avatars/<userId>/<sha256>.<ext>`；未配置 R2（预览、测试）时存 `user_avatars.inlineContent`（bytea，≤200 KB，表上有 CHECK）。**没有用 data URL 写进 `user.image`**：`user.image` 会随每次 `getSession`、成员列表和 RSC payload 下发，200 KB 的 data URL 会让每个请求都变重。
- 读取：`GET /api/avatars/:userId/:sha256`（`app/api/avatars/[userId]/[hash]/route.ts`），不需要登录（队友、iOS 端都要能显示，和 Google 头像一样是公开图片；URL 含内容哈希）。`cache-control: public, max-age=86400`，`nosniff` + `sandbox` CSP。

## 名称

```ts
updateDisplayName(name: string): Promise<ActionResult<{ name: string }>>
```

已有。去首尾空格后 1–80 字符，否则 `validationNameRequired`。

## 修改密码 / 设置密码

```ts
getPasswordStatus(): Promise<ActionResult<{ hasPassword: boolean }>>
changePassword(input: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }): Promise<ActionResult<{ revokedOtherSessions: boolean }>>
setPassword(input: { newPassword: string }): Promise<ActionResult<{ hasPassword: true }>>
```

- `getPasswordStatus`：账户是否有邮箱密码（`credential` 账户）。`true` 显示「修改密码」，`false` 显示「设置密码」（只用 Google/GitHub 登录的账户）。
- `changePassword`：Better Auth `changePassword`，必须提供当前密码。`revokeOtherSessions: true` 时其他设备全部退出，当前设备保持登录（Better Auth 会换发新会话 cookie）。
- `setPassword`：Better Auth `setPassword`（server-only 接口），给没有密码的账户加上密码，之后可以用邮箱 + 密码登录。不需要当前密码，只需要有效会话。
- 新密码长度 8–128（Better Auth 默认值，`lib/auth.ts` 未修改），服务端先校验。
- 错误码：
  - `passwordIncorrect`：当前密码错误或为空。
  - `passwordTooShort` / `passwordTooLong`：新密码长度不符。
  - `passwordNotSet`：对没有密码的账户调用了 `changePassword`，UI 应改走「设置密码」。
  - `passwordAlreadySet`：对已有密码的账户调用了 `setPassword`，UI 应改走「修改密码」。
  - `authRequired`。

## 登录设备

```ts
listSessions(): Promise<ActionResult<{ sessions: SignedInDevice[] }>>
revokeSession(sessionId: string): Promise<ActionResult<{ revoked: true }>>
revokeOtherSessions(): Promise<ActionResult<{ revoked: number }>>

interface SignedInDevice {
  id: string              // 会话 id（不是 token，token 永不下发）
  label: string | null    // 'Chrome · macOS'、'Safari · iPhone'、'Mikka · iPhone'；UA 无法识别时为 null
  client: string | null   // 'Chrome' | 'Safari' | 'Edge' | 'Firefox' | 'Opera' | 'Arc' | 'Brave' | 'Samsung Internet' | 'Mikka'
  os: string | null       // 'macOS' | 'Windows' | 'iPhone' | 'iPad' | 'Android' | 'Linux' | 'ChromeOS'
  app: boolean            // Mikka iOS App 自己的请求
  current: boolean        // 当前这台设备
  createdAt: string       // 登录时间
  lastActiveAt: string    // 最近活跃
}
```

- `listSessions`：当前账户所有未过期会话，当前设备排第一，其余按最近活跃倒序。直接查 `session` 表（Better Auth 的 `listSessions` 要求「新鲜会话」(<1 天)，设置页不适用）。
- `lastActiveAt` 是会话的 `updatedAt`。Better Auth 每天最多刷新一次（`session.updateAge = 1 天`），所以精度是「天」，UI 不要显示到分钟。
- UA 解析在 `lib/account/user-agent.ts`。`Mikka/<build> CFNetwork/… Darwin/…`（RN 网络请求）或 Expo Go 识别为「Mikka · iPhone」（App 只支持 iPhone）。注意：iOS App 通过系统浏览器 OAuth 登录时，会话是在 Safari 里建的，这种会话显示为「Safari · iPhone」——UA 里没有可区分的信息。
- `revokeSession(id)`：只能撤销**本人其他**会话。传当前会话 id → `sessionIsCurrent`（当前设备用「退出登录」）；别人的或不存在的 id → `sessionNotFound`（不区分，不泄露别人的会话是否存在）。
- `revokeOtherSessions`：Better Auth `revokeOtherSessions`，返回被退出的设备数（调用前统计的未过期会话数）。
- 错误码：`sessionIsCurrent`、`sessionNotFound`、`authRequired`。

## 导出我的数据

```ts
requestDataExport(): Promise<ActionResult<{ email: string; expiresAt: string }>>
```

- 行为：生成一次性下载链接，用现有邮件通道（Resend，`RESEND_API_KEY`，发件人同登录邮件 `AUTH_EMAIL_FROM`）发到账户邮箱。**只有 Resend 接受了邮件才返回成功**；返回的 `email` 用于提示「已发送到 xxx」，`expiresAt` 是链接失效时间（24 小时）。
- 邮件文案：`messages/*.json` 的 `AccountEmail.exportSubject` / `exportBody`，按当前界面语言。
- 下载：`GET /api/account/export/:token`（`app/api/account/export/[token]/route.ts`）。
  - 必须以申请导出的账户登录（未登录 401；其他账户、过期或无效 token 都是 404）。
  - 24 小时内可重复下载（浏览器可能重试）；数据库只存 token 的 sha256。
  - 文件在下载时生成：`mikka-export-YYYY-MM-DD.json`，`no-store`、`no-referrer`。
- 频率限制：每人每小时一次（`account_data_exports` 上加事务内咨询锁判断，两次并发点击不会都通过）。邮件发送失败会撤回这次预约，可以立刻重试。
- 错误码：
  - `emailUnavailable`：没有配置 `RESEND_API_KEY`（或没有配置站点地址 `appOrigin`），不会假装成功。
  - `emailDeliveryFailed`：Resend 拒收或超时。
  - `dataExportRateLimited`，`params: { minutes }`：还要等几分钟。
  - `authRequired`。
- 导出内容（`lib/account/export.ts`，每个查询显式列字段）：账户资料（id、名称、邮箱、头像、创建时间）、登录方式（provider 名）、偏好（推送、记忆开关、时区）、所在工作区（名称、角色）、Bot、Agent、线程（运行 + 用户追加消息）、Bot 聊天消息、任务（本人拥有的 issues）、记忆（user_facts，不含已删除）、Artifact 列表（元数据，不含正文）、已保存的登录（站点、用户名，不含密码/TOTP）、连接（Composio 应用、Linear 组织名、Telegram 用户名、GitHub 仓库、设备、模型订阅的 provider/账户标签）。
  - **不包含**：密码哈希、OAuth access/refresh/id token、会话 token、API key、BYOS 密钥名与摘要、已保存登录的密钥、推送 token。数据库测试断言导出里不含这些值。
  - 未包含：运行的原始输出流（`run_chunks`）、Artifact 正文与截图文件（体积大，可在 Artifact 页单独下载）。

## 已共享的链接

```ts
listSharedLinks(): Promise<ActionResult<{ links: SharedArtifactLink[] }>>

interface SharedArtifactLink {
  artifactId: string
  title: string
  kind: ArtifactKind
  links: number      // 这个 Artifact 当前有效的分享链接数
  sharedAt: string   // 最新一条有效链接的创建时间
}
```

- 列出本人 Artifact 上、本人创建且未撤销的分享，按 Artifact 聚合（「N 个」= `links.length`），最新分享在前。
- 停止分享复用 `stopSharingArtifact(artifactId)`（`app/actions/artifacts.ts`，返回 `{ revoked: number }`），会结束这个 Artifact 的**所有**链接。
- 运行截图的分享（`run_capture_shares`）不在此列表。
- 错误码：`authRequired`。

## 退出登录

已有（`authClient.signOut`）。注意 multiSession 插件会把同一浏览器里登录的其他账户一起退出。

## 删除账户

```ts
deleteAccount(input: { email: string }): Promise<ActionResult<{ deleted: true }>>
```

- 入参：确认弹窗里用户输入的邮箱。服务端去首尾空格、忽略大小写，与会话账户邮箱比对。
- 成功后：数据已删除、会话已全部失效，并清掉当前浏览器的会话 cookie（`signOut`，同浏览器其他账户也会退出）。UI 应跳转到登录页。弹窗里提示先「导出我的数据」由 UI 负责。
- 错误码：
  - `accountEmailMismatch`：输入的邮箱与账户不一致（或为空）。
  - `accountSoleAdmin`，`params: { workspaces, count }`：本人是某个**有其他成员**的工作区唯一的活跃管理员。`workspaces` 是逗号分隔的工作区名。什么都不删，UI 提示先在成员设置里把管理员转给别人。
  - `authRequired`。
- 删除范围（`lib/account/delete.ts`）：
  - **主库**：在一个事务里，按所有表的拥有者列（`userId` / `ownerId` / `owner_id` / `user_id`）删除本人的行——运行时从 `information_schema` 发现，以后新增的表自动覆盖。包括 Bot 及其线程、Bot 聊天、Agent、设备、任务、记忆、偏好、已保存的登录、模型订阅（BYOS）、Composio/Linear/Telegram/GitHub 连接、Artifact 及分享、截图、导出链接、头像、Factory 记录等。最后删除 `user` 行，外键 CASCADE 带走会话、登录账户、OAuth 授权等。
  - 外键顺序：先删「别处指向本人行、且没有 ON DELETE CASCADE」的行（如 `byos_native_runs → byos_bindings`），然后逐条删除；某条因外键被挡就留到下一轮（savepoint 回滚），直到全部完成。如果某一轮一条也删不掉（被不属于本人的数据引用），整个删除回滚并抛错（非预期错误，不是错误码）。
  - **工作区库**（`lib/workspace-db.ts`，生产环境可能是另一个数据库）：
    - 只有本人一个成员的工作区（包括每人自动创建的个人工作区）：整个删除（团队、团队成员、团队任务链接、项目链接、邀请、成员、工作区）。
    - 与他人共享的工作区：只移除本人的成员身份和团队成员身份；发给本人邮箱的待处理邀请删除。
    - 本人的项目（`workspace_projects`）删除，但挂在共享工作区团队下的项目保留。
  - **共享工作区里留给团队的内容**：团队任务（`mikka_team_issues` 里的 issue，含正文、版本、成员）保留，`issues.userId` 仍是原 id（指向已不存在的用户）；本人创建的群聊（共享工作区、还有其他成员时）保留，本人的成员身份删除，**本人发过的群聊消息保留**在群聊历史里。本人对他人任务的成员身份（`issue_members.memberId`）删除。
  - **一致性**：工作区库的事务先加锁并检查，主库事务提交后工作区库再提交。主库失败 → 工作区改动一起回滚；工作区库在主库提交后才失败（极少见）会留下孤立的成员行，需要人工清理。
  - R2 文件（Artifact 版本、截图、头像）在主库提交后尽力删除，失败只记数量日志。
- **已知未处理**（需要产品/运维决定）：
  - `improvement_*` 自我改进账本表有触发器禁止 DELETE（append-only 评估证据），不删除；里面可能有该用户 id。
  - 远端资源没有主动销毁：云电脑/云桌面实例、Composio 远端连接、Linear OAuth 授权、Telegram 绑定只删了本地记录，没有调用对方 API 吊销。
  - 头像 URL 有 1 天浏览器缓存，删除后最长 1 天内仍可能从缓存显示。

## 数据库变更

`drizzle/20261029200358_account_settings.sql`（同步 `lib/db/schema.ts`）：

- `user_avatars`：`userId` 主键（FK → user，CASCADE），`sha256`、`contentType`、`size`（≤204800）、`storageKey` / `inlineContent` 二选一。
- `account_data_exports`：`id`、`userId`（FK → user，CASCADE）、`tokenHash`（唯一）、`createdAt`、`expiresAt`、`downloadedAt`。

## 新增错误码

`avatarInvalidType`、`avatarTooLarge`、`passwordIncorrect`、`passwordTooShort`、`passwordTooLong`、`passwordNotSet`、`passwordAlreadySet`、`sessionNotFound`、`sessionIsCurrent`、`emailUnavailable`、`emailDeliveryFailed`、`dataExportRateLimited`（`{minutes}`）、`accountEmailMismatch`、`accountSoleAdmin`（`{workspaces}`、`{count}`）。

## 测试

- `pnpm test:account`：`lib/account/account.test.ts`（UA 解析、头像校验/路径）、`lib/account/mail.test.ts`（邮件只在 provider 接受时算成功）、`tests/account-actions.test.ts`（每个 action 的会话要求、校验、错误码映射）。
- `pnpm test:account-db`：`lib/account/store.db.test.ts`（设备列表、分享列表、导出频率/归属/过期、导出不含密钥、头像替换、删除账户的范围、唯一管理员拒绝、外键 fixpoint）。CI 通过 `pnpm test:db` 在 `mikka_e2e` 上跑；本地用 `ACCOUNT_DB_TEST=1` + 回环的 `*_e2e` 库。
