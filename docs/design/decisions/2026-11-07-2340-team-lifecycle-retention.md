# Team 生命周期：归档、移除分组与受限硬删除

- Date: 2026-11-07
- Source: [#1687 工作包 A](https://github.com/alexj11324/Mikka/issues/1687)，要求「archive/remove grouping 与 hard delete 分离、恢复/审计策略」，以及本 Epic 的实施决定：没有受测的业务对象回收站时，不执行非空 Team 的不可恢复级联删除。
- Rule: Workspace 是 Task/Project 的租户；Team 是可选分组。共享工作区成员默认可见 Team，包括归档 Team 的历史；Team membership 不扩大 Workspace 权限。
- Replaces: `deleteTeamData` 删除 Team 下 Task 和独占 Project 的实现。既有删除请求不被转换为归档或解除分组，而是明确拒绝非空 Team。

## 操作契约

| 操作 | Team | Task/Project 关联 | 历史与恢复 |
| --- | --- | --- | --- |
| Archive | 记录 `archivedAt`、`archivedBy` | 全部保留；禁止新任务、项目和成员加入 | Task、Project、Run、PR、事件和编号不变；可 Restore |
| Restore | 清空归档字段 | 保留现状，不覆盖期间移走的任务 | 同一 Team UUID；可再次接收关联 |
| Remove grouping | 明确输入团队名称后移除 Team 与分组关联 | Task 变为当前 Workspace 的未分组；Project 只失去该 Team 的链接 | 所有业务对象、ProjectTask 关系、Run/PR、正式编号和历史 alias 保留；分组快照留在审计日志。没有隐式“恢复全部关联”操作 |
| Hard delete | 明确输入团队名称，只允许空 Team | 如有关联 Task、Project 或冻结 Run/PR 引用，返回 `teamDeleteReferenced` | 不删业务对象；移除空 Team 的行为留审计。未来如要允许非空硬删，必须先实现并验证完整回收与恢复协议 |

所有操作要求 Team 所属 Workspace 的当前活跃管理员身份；Team owner 不是 Workspace 管理员时不能执行生命周期操作。PAT 另受其绑定 Workspace 约束。预览报告当前 Task、全部关联 Project（含多 Team Project）、Run 和去重 PR 数量，以及是否具备硬删除资格。执行时重新计算，不能依赖客户端过期计数。

归档对历史读取不撤权。普通 Team 选择列表默认排除归档项，管理目录可包含归档项。Personal Workspace 创建 Team 由服务端和数据库共同拒绝。迁移保留遗留记录，不凭其创建者重新猜测归属。

## 一致性和并发

生命周期操作按 Workspace/管理员成员 → `mikka-team-relations` 事务锁 → Team 行的顺序取锁，与 canonical Task/Project 写入一致。归档不跨数据库修改业务数据。移除分组前，所有仍存在的 Task 必须已经绑定同一 Workspace，Project 必须拥有相同 canonical `workspaceId`；pending 或冲突的遗留归属返回 `teamLifecycleConflict`，保留修复线索。

普通 Team 关系写入持有 Workspace/member 的共享锁，随后只锁定 Team 行；不能在取得关系锁后将租户共享锁升级为排他锁。已有明确 Workspace 的调用在预读 Team 归属后即拒绝跨 Workspace 目标，不进入其他租户的锁序。

Workspace 数据库的触发器在插入/更换 Team 关联时取得 Team 行共享锁，拒绝归档 Team 和跨 Workspace 链接；已有归档链接可保留、解除或移到可用 Team。Team 创建及项目绑定服务在创建 APP 对象之前也检查归档状态，避免两个数据库之间先写后失败。

移除 Team 不删除 Project，也不触及 `workspace_project_tasks`、项目成员、依赖、milestone、项目版本或事件。Task 编号由稳定身份 ADR 的迁移和 Team 解绑触发器保存历史 alias；解绑不是重新发号或重新发布 PR。

## 审计、恢复与发布

`team_lifecycle_events` 与 Workspace 的变更同事务提交，记录操作者、动作、时间、Team 名称/标识、关联 Task/Project ID 与任务编号、成员、Run/PR 数量。日志不以 Team 外键级联，因此移除 Team 后管理员仍可查询；Workspace 删除通过外键删除所属日志。它是操作证据，不是假称可恢复任意业务内容的备份。

归档恢复使用独立 `restoreTeam` 接口，重复 archive/restore 不制造重复事件。移除分组保留业务对象，所以不需要恢复已删除的 Task/Project；如需重新组织，管理员创建/恢复团队后显式分组，不能覆盖他人的后续安排。空 Team 的硬删除不可撤销，但不会丢失业务对象。

迁移 `20261111010003_team_lifecycle.sql` 仅添加可空列、审计表与约束触发器，可重复执行；没有破坏性回填。回退应用前保留这几个新增结构即可。不得回滚到会对非空 Team 级联硬删的旧实现；生产问题通过前进修复处置。

数据库回归位于 `tests/team-lifecycle.db.test.ts`：权限、personal 拒绝、精确影响计数、archive/restore 幂等、历史快照不变、所有新增关联入口、APP saga 无先写残留、移除分组、跨 Workspace 保留、pending 归属拒绝、并发归档与关联竞争。API/RPC 验收使用相同独立操作，UI 由 #1659 owner 接线；本 ADR 不宣称 UI 已完成。
