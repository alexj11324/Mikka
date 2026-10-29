# README 与图表刷新（2026-10-28）

## 目标

把 `main` 同步到最新 `origin/main`，并让 README（中英双语）与 `docs/assets` 图表反映当前真实上线状态。

## 上线状态核实

| 能力 | 结论 | 证据 |
| --- | --- | --- |
| 跨设备接续 / checkpoint | 已上线 | PR #201、#189 已合并，无 feature flag，daemon 与 `/v1/runs/:id/checkpoint` 均在 main |
| 连接应用「审批后操作」 | 已上线 | PR #204 已合并；`send_email`、`create_calendar_event`、`update_calendar_event` 走 pending-action 卡片 |
| Slack 指令通道 | 已上线 | PR #51 已合并；PR 描述记录了生产回调验证 |
| 多 bot 与新建 bot | 已上线 | PR #322 已合并；`app/actions/bots.ts`、`components/nav/bot-list.tsx` 无开关；Coordinator 是其中一个 bot |
| 云端电脑（E2B） | **已上线（此前判断错误）** | 生产 Vercel 有 `NEXT_PUBLIC_COMPUTER_ENABLED=1`、`MIKKA_CLOUD_COMPUTER_TASKS=1`、`MIKKA_BYOS_ENABLED=1` 和 E2B 凭据；生产接口返回 401 而非 503；前端 bundle 中 `useCloudComputer` 末尾折叠为 `true`。issue #172 仍 OPEN 只说明完整验收未收尾 |
| 原生 Coordinator 运行时 | 未上线 | `MIKKA_NATIVE_COORDINATOR === '1'` 才启用，默认关闭 |
| iOS App | 未上线 | PR #340 已合并，但 `docs/design/mobile.md` 仍是 draft，TestFlight 验收未完成 |
| Factory / 定时任务 / 凭据库 / 群聊 | 未上线 | issue #191–#195、#179、#180、#105 均 OPEN |

## 剩余「规划中」项核查（2026-10-28）

| 功能 | main 里的实现 | 生产开关 | 未合入的工作 | 结论 |
| --- | --- | --- | --- | --- |
| Factory（#191–#195） | 无 | 无 | `codex/factory-*` 分支，无 open PR | 未上线，虚线正确 |
| Monitoring（#195） | 无 | 无 | `codex/issue-192-monitor-*` 分支 | 未上线，虚线正确 |
| 定时任务（#179） | 无 | 无 | `codex/179-conversation-schedules` 分支 | 未上线，虚线正确 |
| 群聊（#105） | 无 | 无 | PR #318（draft，只读群聊）、#166 | 未上线，路线图正确 |
| 凭据保管库（#180） | 无用户路由/UI | 无应用代码读取 `CREDENTIAL_*`（仅 AWS 操作文档） | PR #345（draft） | 未上线，虚线正确 |
| 本机 computer use（#147） | 无 cua-driver 代码 | 无 | PR #157（draft） | 未上线，虚线正确 |
| iOS App | `apps/mobile` 已合入（#340） | 无 EAS 构建/TestFlight | PR #381 | 未发布，路线图正确 |
| 原生 Coordinator | 已合入（#314），`MIKKA_NATIVE_COORDINATOR` 未设置 | 关闭 | PR #341 计划废弃 | 不算上线 |
| Connected apps 剩余 | Notion/Slack 只读；Gmail/Calendar 可写 | 审批写已上线 | 无 Notion/Slack 写 | 部分上线，路线图已按剩余范围改写 |
| ⌘K 搜索 | 已合入，覆盖 bot、对话、任务、项目 | 无开关 | 站点级搜索在 PR #318（draft） | ⌘K 已上线，README 已补；全站搜索仍规划 |

## 待办

- [x] 拉取 origin/main 到 main
- [x] 核实各功能上线状态
- [x] 更新 `scripts/generate-diagrams.mjs`：Slack 入口、已上线的审批操作改为实线、handoff 标注为云端接续
- [x] 重新生成 8 张 SVG
- [x] 更新 `README.md`
- [x] 更新 `README.zh-CN.md`
- [x] 渲染 SVG 检查版面（中英、明暗共 4 张抽样）
- [x] 建分支、提交、推送并开 PR

## 结果

- PR: [#384](https://github.com/alexj11324/Mikka/pull/384)
- 提交: `2cbf4e34` `docs: refresh README and diagrams for shipped features`
- 额外修正：多 bot（PR #322）已上线，README 原来的「Coordinator 是当前唯一内置 Bot」已过时，改为「左侧栏是 bot 列表，Coordinator 是其中之一」。
- 追加修正（2026-10-28）：E2B 云端电脑在生产已启用，README 与架构图从「规划中」改为「已上线」；虚线框改实线，`cloud handoff` 改为已上线的 `cloud run`。

## 验收纠正（后续复核，覆盖上文宽泛的“已上线”结论）

- #317 的生产证据支持 Coordinator 唤醒真实 E2B、查看、接管和交还；不支持托管 Codex/Claude 订阅编码运行已通过真实推理验收。
- #201 有 daemon 与真实 Postgres 测试；真实双机交接仍待验收。
- #204 已接入邮件/日历待审批执行路径；未找到真实外部写入验收证据。后续 #374 是默认关闭的前置实现，也不补足这项验收。
- #383 为默认关闭的 mailbox 前置实现；不补足人工回答持久回送等待运行的完整验收。
- Factory、定时任务、凭据保管库、本机 computer use 等已有候选工作；issue 开放或未合入不等于尚未开始。由既有负责人继续逐项核实。
- 最新目标策略为模型判断业务语义，已有 allow 直接执行、ask 请求确认、deny 停止；保留鉴权、凭据保护、幂等和机械验证。文档更正不代表运行时整改完成。
- 本次以 PR #384 为唯一 README/图整合入口；#380/#382 各自文档分支需对账，不依次合并互相覆盖的版本。

## 状态更新（2026-10-29）

上文最后一条是当时的合并顺序说明，不是当前状态：PR #341、#380、#382 已依次正常合入 `main`。PR #384 已干净整合当前 `main`（`30467ee9525203a8082643c86cc09f2269048e31`），合并提交 `ac97803115a5396d7b39e62c50dd2d4e9e381a07`；未发生冲突。这个整合仍需推送并在新 PR head 上完成检查，尚未合并。
