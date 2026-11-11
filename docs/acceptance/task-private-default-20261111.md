# Task 创建隐私：ALE-85 SQL 与真实写入入口

本补丁将 APP 数据库的新建/重绑定资源默认值收为 private；Team 根 Task 共享由持有真实 Workspace 租约的生产写入入口在同一 APP 事务显式登记。APP 不查询或复制 Workspace 的 kind/member 表。历史 personal shared 行与个人重新分享守卫由同一 ALE-85 包的应用层修复覆盖，SQL 默认值本身不宣称清理了旧行。

## 迁移与租约

新文件 `20261112030503_task_acl_private_default.sql` 由仓库 UTC 生成器生成。2026-11-11 16:26:48 UTC 的远端 refs 快照覆盖 2,330 个 heads、267 个 tags、2,594 个唯一目标，查询缺口为 0；候选 `20261112030503` 无占用。该快照的 main 为 `43838a6efd6b66472b0c1f221829125bfb31fe34`，main 迁移水位为 `20261112030500`。合并前仍须重新核对最新 main 水位；远端其他分支的最大编号不能代替 main 水位，也不能按固定编号区间取号。

`requireTaskWorkspaceLease` 只返回当前仍有效的 Workspace lease 中已锁定的 kind；校验 actor、Workspace 和事务身份。登记 helper 还交叉校验 kind，且仅匹配本 APP 事务新建、revision1、无父节点的 private/created Task policy。以后重新进入合法 Team 租约不能将既有 private 根 Task 当作新建重新公开。

## 生产写入覆盖

| 入口 | 结果与权威来源 |
| --- | --- |
| `lib/issue-create.ts` | 普通创建、Team 创建、Telegram、Factory monitor、Coordinator 复用同一 helper；原外层 withTaskWorkspace/withTeamWorkspace 提供权威 kind 与锁。冻结目录无需变更 |
| `lib/linear-sync/issue-sync.ts` | 仅真实 incoming 新建路径登记；provider identity、成员与绑定校验保留，personal import private、Team import shared |
| `app/actions/issue-operations.ts` | Team child 保持 shared 与父策略交集；personal child private；duplicate 根/子树的既有 private 与祖先规则保留 |
| `scripts/task-workspace-backfill.mjs` | 历史管理工具在原 WS FOR SHARE 锁中读取 kind；只有 Team 证据可恢复刚解析 quarantine 根 Task 的 legacy shared；未登记及 personal 绑定仍 private |
| 原始 SQL/未知写入 | 有 Workspace 时 private，无 Workspace 时 quarantined；scope 字符串不能授权共享 |

该迁移不删除或改写 account/service grants。Task 的 private 状态与明确授权是两个独立约束；共享的祖先规则也没有被绕过。

## 权限对照

| action | 合并前 | 合并后 | 放宽了？ | 依据 |
| --- | --- | --- | --- | --- |
| 原始 Task INSERT | 只要有 workspaceId 就 shared | private；缺租户仍 quarantined | 否，默认收紧 | 新迁移 `mikka_resource_acl_register` |
| personal 正常创建/子任务 | SQL 默认或 child override 可为 shared | private | 否 | `lib/issue-create.ts`、`app/actions/issue-operations.ts` |
| Team 正常根 Task 创建 | SQL 自动 shared | 权威 kind lease 下新行显式 shared | 保留现有能力 | `lib/task-resource-registration.ts` |
| 重登记既有 private Team Task | 旧触发器不针对该操作 | helper 拒绝既有行，沿用原 server 共享函数的权限与确认契约 | 否 | revision 与 transaction_timestamp guard |
| quarantine 历史绑定 | Task 自动 shared | 默认 private，仅锁内 Team kind 显式恢复 | 否，裸绑定收紧 | 回填脚本与新 SQL |
| personal 的 server 共享函数 | 可将 policy 设为 shared | 权威 personal Workspace 租约内拒绝设为 shared | 否，收紧隐式共享 | `lib/resource-access/store.ts` |
| 历史 personal shared 修复 | 旧 policy 保持 shared | 显式维护命令将选中个人 Workspace 的 shared policy 收为 private | 否，收紧；明确 grants 保留 | `scripts/repair-personal-resource-privacy.mjs` |
| account/service 明确授权 | 原 resource grants | 原行、capabilities、expiry 均保留 | 否 | 双库迁移与回填回归 |

这里的共享入口是导出的 server 共享函数；未找到已登记的 HTTP、RPC 或 UI producer。因此本补丁不据此声称存在可从公开分享接口触发的线上泄漏。

## 历史修复操作

SQL 默认值、生产 Team 登记和个人共享守卫必须随同一 PR 部署，并确认服务 READY 后，才开始历史修复。仅应用迁移不能完成旧行清理；先修旧行而仍运行旧 writer，也不能保证后续创建保持 private。构建、迁移和应用启动均不自动对生产执行修复。

维护 CLI 从 `MIKKA_DATABASE_URL` 连接 APP 库，从 `DATABASE_URL` 连接权威 Workspace 库。由操作者在当前维护环境配置这两个连接，不要将带口令的连接串写入命令、工单或报告。先对计划处理的 Workspace 执行默认 dry-run：

```sh
node scripts/repair-personal-resource-privacy.mjs \
  --workspace PERSONAL_WORKSPACE_UUID
```

未传 `--apply` 时不更新 policy；未指定 `--workspace` 的 dry-run 会扫描所有 personal Workspace。核对结果与目标后，apply 必须显式给出每个 Workspace ID、审计 actor 和两个精确的 `host:port/database` 目标；它们必须与当前环境连接一致：

```sh
node scripts/repair-personal-resource-privacy.mjs \
  --workspace PERSONAL_WORKSPACE_UUID \
  --actor MAINTENANCE_ACCOUNT \
  --app-target APP_HOST:5432/APP_DATABASE \
  --workspace-target WORKSPACE_HOST:5432/WORKSPACE_DATABASE \
  --apply
```

多个 Workspace 使用重复的 `--workspace` 参数。actor 是本次维护审计标识，不能替代数据库运维授权或 Workspace 权威判断。以上是操作格式，本文没有执行任何生产 apply。

工具逐 Workspace 在 WS 库读取并持有真实 `kind='personal'` 行的 `FOR SHARE` 锁，再对 APP 中该 Workspace 的 shared policy 分批处理；每个 APP 事务最多 200 行。更新仅将 visibility 收为 private，原有 policy 触发器在同一事务记录旧值、actor 和来源 `personal_resource_privacy_repair`。已提交的批次无需重做，重试只处理剩余 shared 行；完成后再次 dry-run 应无剩余候选。Team Workspace 不在修复范围内。

修复保留资源 owner、持久 Workspace 归属、父级/祖先约束以及全部 account/service grants，不将 private 等同于撤销明确授权。若 policy 的 ownerId 与个人 Workspace 的权威 owner 不一致，工具仍只收紧该 shared policy，并在 `ownerMismatches` 计数中报告；它不宣称已核实历史 ownership，也不转移 owner、Workspace 或 grants。该类历史异常需要单独核查，不能通过此工具自动归属。

此维护 CLI 的作用范围是数据库更新与审计。结果的 `liveInvalidations: "not_sent"` 明确表示未发送实时失效通知，不能声称所有客户端已立即刷新。下一次正常读取会按新 ACL 判断权限；客户端此前已经显示的内容无法收回。

## 验证范围

`tests/task-resource-registration.db.test.ts` 全量回放到旧 ACL 版本，先实证旧 personal INSERT 得到 shared，再执行新迁移，使用两个独立 PG 数据库验证 raw/伪 scope、quarantine 绑定、真实普通与 Linear 生产创建、历史 Team 回填、Team 同伴读、过期/伪造租约及 Workspace 锁。APP 库不存在 `mikka_workspaces`，不能意外靠同库 join 通过。

原 `tests/team-issue-create.db.test.ts` 的人工 receipt 构造片段补了真实 withTaskWorkspace 租约，所有原断言保留；实际 Team 创建与重试路径使用原生产 writer，未用 shared fixture 替代接线。新双库回归也实际调用 child/duplicate action，分别核对 personal/private、Team/shared 与父策略；框架会话、翻译和后台调度沿用仓库既有 activity fixture，ACL、成员与生产 writer 均真实执行。原 `tests/issue-visibility-narrow.db.test.ts` 保留读取边界回归。

相关命令：

```sh
node --experimental-test-module-mocks --test-force-exit \
  --import ./scripts/server-test.mjs --import tsx --test \
  tests/task-resource-registration.db.test.ts \
  tests/issue-visibility-narrow.db.test.ts tests/team-issue-create.db.test.ts
```

运行前按仓库验收文档配置真实 loopback `*_e2e` PostgreSQL；测试创建并清理自己的 APP/WS 库。保留型旧 Team suite 的临时库由该 suite 自身的现有清理协议管理。本记录不证明外部 Linear/OAuth、模型订阅或部署验收。
