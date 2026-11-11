# Task 创建隐私：ALE-85 SQL 与真实写入入口

本补丁将 APP 数据库的新建/重绑定资源默认值收为 private；Team 根 Task 共享由持有真实 Workspace 租约的生产写入入口在同一 APP 事务显式登记。APP 不查询或复制 Workspace 的 kind/member 表。历史 personal shared 行与个人重新分享守卫由同一 ALE-85 包的应用层修复覆盖，SQL 默认值本身不宣称清理了旧行。

## 迁移与租约

新文件 `20261112030503_task_acl_private_default.sql` 由仓库 UTC 生成器生成。2026-11-11 16:11:09 UTC 复核时，origin/main 为 `43838a6efd6b66472b0c1f221829125bfb31fe34`，main 最大编号为 `20261112030500`；本地已知 refs 另有 Drive `20261112030502`，候选没有已提交碰撞。发布前仍需协调者核最新远端 refs，不能用固定编号区间代替该检查。

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
| account/service 明确授权 | 原 resource grants | 原行、capabilities、expiry 均保留 | 否 | 双库迁移与回填回归 |

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
