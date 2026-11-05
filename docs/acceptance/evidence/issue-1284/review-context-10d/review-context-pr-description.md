## 问题与证据

ALEX67 的正常 Owner 恢复已保留候选，但自动 Review 的 Profile Decision 返回 `uncertain_profile`，因此没有创建 Review Run。三个候选当时均可用。历史返回的具体候选 ID 与置信度没有保存，不能把输入缺口直接断言为该次低置信度的完整原因。

代码和真实 PostgreSQL 红灯确认：自动 Review 在选择 Profile 时仅提供原 Issue 实现请求和 `stage` 标记。独立只读职责、当前候选和 producer 上下文要到选完 Profile、创建 Run 后才加入。

## 变更

- 在已锁定 Task 的事务里，从当前 candidate 与实际 producer 的 owner/issue 关联生成最小宿主上下文，先交给现有 Profile Decision。
- 明确当前任务是检查既有候选的正确性与回归、使用实现已有的验证证据；原 Issue 保留为不可信背景。保留 nullable candidate SHA，逐字段投影，不发送私有 Profile 指令、Skills 内容、native SID、凭据或原始报告。
- 只在既有拒绝日志里增加已确认属于候选目录的 `selectedProfileId` 和有限 0..1 的 `decisionConfidence`；无效值、未知 ID 不记录，不新增存储或路由。
- 保持 0.55 阈值、精确 ID 选择、none/拒绝行为、Default/explicit/checkStart 恢复与全部权限/凭据门禁。

## 验证

- 原产品 9727 + 新回归：Profile unit 12/13 通过，真实 Profile-dispatch PG 42/47 通过；缺失 currentWork 和拒绝日志诊断的预期红灯均保留。
- 修复后：17/17 unit、47/47 真实 PG，零失败、零跳过；合法低置信度仍拒绝且不创建 Run/binding。
- 全树 types、五文件 oxlint、diff check 通过。PG 绿后仅补一个 TypeScript optional 返回类型注解，运行逻辑不变；随后重新完成 types 与 17 项 unit，收据未把 PG 结果冒称为重跑。
- 只用隔离 PG 和合成 Decision/provider 边界，无真实模型调用、生产 SQL 或外部 API 验证；付费 API 路径未测试。
- 本组测试 role/数据库已正常清理，其他工作树及 PostgreSQL 服务保留。

## 风险与边界

触发范围是已有候选的自动独立检查选择；旧路径总是缺少上述职责摘要，生产已观察到一次在三个候选均可用时因低置信度阻断。影响是 Review 无 Run、任务等待 Owner 恢复。补丁修复可复现的输入合同，不保证模型一定选择某个 Profile，也不硬选 Harness。真实恢复能否启动并完成独立 Review，仍须在部署后通过正常 Owner 流程验证。ALEX66 runtime 问题不在本 PR 范围。
