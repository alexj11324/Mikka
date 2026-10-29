# 设置页后端：已保存的登录、活动、设备

所有 action 都是 server action，用 `runAction` 包装，返回 `ActionResult<T>`：成功时是数据本身，失败时是 `{ error: ActionErrorCode, params? }`。每个 action 都先从会话取当前用户（没有会话返回 `authRequired`），客户端传来的 id 只和这个用户一起匹配，别人的数据一律按“不存在”处理。

| 文件 | 内容 |
| --- | --- |
| `app/actions/settings-activity.ts` | `listSavedLogins` `deleteSavedLogin` `listSavedLoginUsage` `listActivity` |
| `app/actions/agents.ts` | `renameDevice` `removeDevice`（和已有的 `listDevices` `setDeviceEnabled` 放在一起） |
| `lib/settings/saved-logins.ts` | 已保存登录的查询和删除 |
| `lib/settings/activity.ts`、`lib/settings/activity-cursor.ts` | 活动时间线和游标 |
| `lib/device-removal.ts` | 设备改名和移除 |
| `drizzle/20261029200203_settings_activity_devices.sql` | 数据库变更 |

新增错误码：`savedLoginNotFound`、`deviceHasActiveRuns`（`messages/*.json` 的 `Errors` 下有对应文案）。

## 已保存的登录

数据来自 `credentials`（未撤销的行），使用记录来自 `credential_access_events`（由 `lib/credentials/broker.ts` 写入）。

### `listSavedLogins(): ActionResult<{ logins: SavedLogin[] }>`

```ts
interface SavedLogin {
  id: string               // credentials.id
  site: string             // 规范化的 https origin
  account: string          // 用户名或邮箱
  lastUsedAt: string|null  // ISO；max(credentials.last_used_at, 最近一次成功使用)
  lastUsedBy: string|null  // 最近一次成功使用的 Bot 名；Bot 已删除或不明时为 null
}
```

- 不返回密码、会话、密钥、`credential_secrets` 的任何字段。
- “成功使用”指 `decision <> 'denied_or_failed'` 的事件。
- 错误码：`authRequired`。副作用：无。

### `deleteSavedLogin(id): ActionResult<{ id: string }>`

- 先按 `id + 当前用户 + 未撤销` 找到这条登录，再调用现有的 `CredentialStore.remove`（和 `DELETE /api/credentials` 同一段逻辑）。
- 副作用（同一事务、同一个 `credentials:<user>:<origin>` 咨询锁）：
  - `credentials.revoked_at = now()`：`lease` / `otpLease` / 浏览器 `login` 都只取 `revoked_at IS NULL` 的行，之后返回 `needs_login`；
  - 未消费的 `credential_fill_leases` 被标记为已消费并清空 `input_envelope`，broker 的 `fillCredential` 拿已有租约也会被拒；
  - `browser_sessions.expires_at` 被截到 `now()`，已保存的会话不能再恢复。
- 错误码：`authRequired`；`savedLoginNotFound`（id 不是 uuid、不属于当前用户、已删除）。
- 已删除的登录不再出现在列表中；它的使用记录仍可通过 `listSavedLoginUsage` 和活动查看。

### `listSavedLoginUsage(id): ActionResult<{ uses: SavedLoginUse[] }>`

```ts
interface SavedLoginUse {
  id: string                // credential_access_events.id（字符串）
  at: string                // ISO
  botId: string|null
  botName: string|null      // 只解析当前用户自己的 Bot
  runId: string|null        // 线程（agent_runs）
  subagentId: string|null   // 云浏览器子任务线程
  issueId: string|null      // runId 所属任务
  result: 'input_inserted_guarded' | 'password_submitted' | 'otp_submitted' | 'session_applied' | 'denied_or_failed'
}
```

- 最新在前，最多 100 条。
- `result` 含义：`input_inserted_guarded` 已填入页面但未提交；`password_submitted` / `otp_submitted` 已提交；`session_applied` 恢复了保存的会话；`denied_or_failed` 被拒绝或失败。
- 限制：broker 在失败路径写的 `denied_or_failed` 事件没有 `credential_id`，无法归到某一条登录，所以只出现在活动里，不在这里。
- 错误码：`authRequired`；`savedLoginNotFound`（不属于当前用户；已删除的登录仍可查）。副作用：无。

## 活动

### `listActivity({ filter?, cursor?, limit? }): ActionResult<ActivityPage>`

- `filter`：`'all'`（默认）| `'accounts'`（账户使用 + 外部操作）| `'reminders'`（Coordinator 提醒）。
- `cursor`：上一页的 `nextCursor`，不传或 `null` 取第一页。
- `limit`：1–100，默认 30。
- 只读，没有副作用。

```ts
interface ActivityPage { items: ActivityItem[]; nextCursor: string|null }

interface ActivityItem {
  id: string            // 'credential:<事件id>' | 'action:<pending_actions.id>' | 'reminder:<attention_log.id>'
  kind: 'credential_use' | 'external_action' | 'coordinator_reminder'
  at: string            // ISO
  botId: string|null
  botName: string|null
  summary: ActivitySummary
  target: {
    runId: string|null; subagentId: string|null; issueId: string|null
    pendingActionId: string|null; matterId: string|null; url: string|null
  }
  decidedBy: 'user' | 'coordinator' | null
}

type ActivitySummary =
  | { kind: 'credential_use'; site: string; account: string|null; credentialId: string|null; result: CredentialUseResult }
  | { kind: 'external_action'; action: string; decision: 'approved'|'declined'; status: string; site: string|null; repository: string|null }
  | { kind: 'coordinator_reminder'; title: string; source: string; level: string; reason: string|null }
```

服务端不拼句子，UI 用 `kind` + `summary` 字段走 i18n。

三个来源（都只取当前用户的行）：

| kind | 来源 | `at` | Bot / 线程 | `decidedBy` |
| --- | --- | --- | --- | --- |
| `credential_use` | `credential_access_events`（`user_id` = 当前用户） | `ts` | `bot_id`、`run_id`、`subagent_id` | `null`（Bot 在权限内自行使用） |
| `external_action` | `pending_actions` 中 `decidedAt IS NOT NULL` 的行 | `decidedAt` | 已批准写操作取 `operationBinding.run.{botId,runId}`；`credential_operation` / `browser_operation` 取 `input.{botId,subagentId}`；其他提案没有记录 Bot，为 `null` | `'user'` |
| `coordinator_reminder` | `attention_log` 中 `action='notify'` 的行，关联 `attention_matters` | `createdAt` | 无 | `'coordinator'` |

字段确认（读过写入点）：

- `pending_actions.decidedAt` 只在本人决定时写入：`decidePendingAction`、`approved-writes.decide`、`writeRepositoryPushApproval`。策略自动放行的写操作直接以 `running` 插入、`decidedAt` 为空，所以不算“用户批准/拒绝”，不进时间线。`decision` 由 `status` 推出：`declined` 为拒绝，其余（`running` / `done` / `failed`）为批准；`status` 原样返回，UI 可以显示“已批准但执行失败”。
- `summary` 只带操作类型和少量定位信息（浏览器/登录操作的 `origin`、仓库推送的 `repo`），不带邮件正文、收件人等 `input` 内容；详情用 `pendingActionId` 跳转。
- `attention_log.reason` 是 Coordinator 记录的原因原文（模型写的文本，或系统写的 `told without recording` 等），原样返回，不翻译。`url` 是 matter 的来源链接。
- 只把 `notify`（告诉了用户）当成提醒；`handoff` / `quiet` / `snooze` / `handled` 是内部决策，不进时间线。

分页：按 `(at DESC, id DESC COLLATE "C")` 全序排序。游标是最后一条的位置，时间用 Postgres 原生的微秒整数（不经过 JS `Date`），所以同一毫秒甚至同一微秒的多条记录不会漏也不会重复；新写入的记录只会出现在第一页之前，不影响已发出的游标。游标被篡改或格式不对时返回 `validationGeneric`。

错误码：`authRequired`；`validationGeneric`（`filter` / `limit` / `cursor` 不合法，或带了多余字段）。

## 设备

### `renameDevice(id, name): ActionResult<{ id: string; name: string }>`

- `name` 去掉首尾空白后 1–60 个字符（和 `createDeviceToken` 的上限一致）。
- 只能改自己的本地设备（`kind='local'`，未移除）。
- 副作用：更新 `devices.name`，并置 `devices."nameLocked" = true`。daemon 每次启动都会 `register` 并上报主机名，加锁后 register 不再覆盖用户起的名字。
- 错误码：`authRequired`；`validationNameRequired`（空）；`deviceNameTooLong`（超过 60）；`deviceNotFound`（id 不合法、不是自己的、云设备、已移除）。

### `removeDevice(id): ActionResult<{ id: string; revokedTokens: number }>`

- 只能移除自己的本地设备。
- 设备上有正在运行的线程（`agent_runs.status` 为 `queued` / `preparing` / `running` / `waiting_input` / `finishing`）时拒绝，返回 `deviceHasActiveRuns`，UI 提示先停止。
- 否则在一个事务里（设备行 `FOR UPDATE`；运行准入读设备行 `FOR SHARE` 并要求 `enabled`，所以检查之后不会再有新运行进来）：
  1. 撤销这台设备的全部 daemon 凭据：`device_token_devices` 里记录过的 token，以及 `boundDeviceId` 指向它的 token，`revokedAt = now()`。`authenticateDevice` 只认 `revokedAt IS NULL`，daemon 下一次请求任何 `/v1/devices/*` 都是 401。
  2. 解除该设备上 agent 的设备绑定（`agents.deviceId = NULL`），之后派发返回 `agentNoDevice`。
  3. 设备行变成墓碑：`removedAt = now()`、`enabled = false`。
- 返回撤销的 token 数。
- 错误码：`authRequired`；`deviceNotFound`（不合法、不是自己的、云设备、已移除）；`deviceHasActiveRuns`。

#### 为什么用墓碑，不物理删除

审计了所有引用 `devices.id` 的表：

| 表 | 外键 / on delete | 物理删除的后果 |
| --- | --- | --- |
| `agent_runs.deviceId` | SET NULL | 历史线程丢失设备 |
| `device_repos.deviceId` | CASCADE | 仓库记录被删，连带 `agent_runs.deviceRepoId` SET NULL，历史线程丢失仓库，反馈资格（需要 `deviceRepoId`）失效 |
| `agents.deviceId` | SET NULL | agent 失去设备（和本方案第 2 步效果相同） |
| `device_tokens.boundDeviceId` | CASCADE | 云 token 被删 |
| `native_coordinator_turns.deviceId` | CASCADE | 原生 Coordinator 轮次被删 |
| `local_computer_reviews.deviceId` | CASCADE | 本机电脑操作审批记录被删 |
| `thread_machines.deviceId` | 无 on delete（RESTRICT） | 有引用时删除直接失败（云设备） |
| `cloud_machines.deviceId` | SET NULL | 云设备专用 |
| `agent_tool_approvals`、`improvement_skill_selections`、`improvement_skill_mounts` 的 `deviceId` | 无外键 | 留下悬空 id |
| `device_token_devices.deviceId`（新增） | CASCADE | — |

物理删除会级联删掉仓库和审批记录，并让历史线程失去设备和仓库。墓碑保留这一切：历史线程的 `deviceId`、`deviceRepoId`、`agentId` 都不变，设备名仍可显示；对历史影响最小。

墓碑设备不再出现或生效的位置：
- `listDevices`、移动端机器列表（`lib/mobile-threads.ts`）过滤 `removedAt IS NULL`；
- `ownedDevice`（所有 `/v1/devices/[deviceId]/*` 路由的归属检查）排除墓碑，返回 404；
- `setDeviceEnabled`、`renameDevice` 不再作用于墓碑，不能重新启用；
- 其余派发、认领、审批路径都已要求 `enabled = true`，墓碑是 `enabled = false`。

#### daemon 凭据和设备的对应关系

本地设备的 token 是用户级的，表里原本没有“哪个 token 属于哪台设备”。新增 `device_token_devices(tokenId, deviceId, userId)`：`POST /v1/devices/register` 和 `POST /v1/devices/:id/heartbeat` 在确认设备属于调用者且未移除后记录这一对（`lib/device-link.ts` 的 `linkDeviceToken`，设备行 `FOR SHARE`，和移除互斥）。daemon 每 15 秒心跳一次，所以上线前已在运行的 daemon 也会在下一次心跳时被记录。

- 同一个 token 被复制到两台机器时，移除其中一台会撤销这个 token，另一台也需要重新登录。
- 没有在这台设备上用过的同用户 token 不受影响；用它拿墓碑 id 去 register 会得到一台新设备，不会复活墓碑。
- 剩余的竞态：上线后某个 token 第一次心跳的同时用户移除设备，这个 token 可能没被记录；它之后只能注册成一台新设备（出现在设置里，可以再移除），拿不到被移除设备的任何东西。

## 数据库变更（`drizzle/20261029200203_settings_activity_devices.sql`）

- `devices."removedAt" timestamptz`、`devices."nameLocked" boolean NOT NULL DEFAULT false`
- 新表 `device_token_devices`，主键 `("tokenId","deviceId")`，两列都 `ON DELETE CASCADE`
- 索引 `pending_actions_user_decided_idx ("userId","decidedAt" DESC) WHERE "decidedAt" IS NOT NULL`
- 索引 `credential_access_credential_time (credential_id, ts DESC) WHERE credential_id IS NOT NULL`

全部是新增，对应 `lib/db/schema.ts` 里的 `devices.nameLocked/removedAt` 和 `deviceTokenDevices`。

## 测试

- `lib/settings/activity-cursor.test.ts`（`test:settings`）：游标往返、伪造游标、输入校验、filter 到来源的映射。
- `tests/settings-activity.db.test.ts`（`test:settings-activity-db`，已加入 CI 的 `DB_TEST_EXPECTED`）：通过真实 server action 和 daemon 路由跑 Postgres，只 mock 会话。覆盖：无会话；已保存登录不含密钥、最近使用的 Bot、使用记录、越权读删、删除后 `lease` 返回 `needs_login`、删除前拿到的租约 `fillCredential` 被拒；活动三源合并、倒序、只看自己的、不泄露 `input`、相同时间戳分页不漏不重、三种 filter、伪造游标；设备改名（长度、空名、越权、register 不覆盖）、有运行中线程时拒绝移除、移除后旧 token 访问 `register` / `heartbeat` / `commands` 都是 401、历史线程的设备/仓库/agent 不变、墓碑不出现在列表也不能重新启用、同用户其他 token 不受影响且不能复活墓碑。
