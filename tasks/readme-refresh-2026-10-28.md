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
| 云端电脑（E2B） | 未上线 | issue #172 仍 OPEN；`docs/acceptance/e2b-cloud-computer.md` 说明生产 flag 关闭 |
| 原生 Coordinator 运行时 | 未上线 | `MIKKA_NATIVE_COORDINATOR === '1'` 才启用，默认关闭 |
| iOS App | 未上线 | PR #340 已合并，但 `docs/design/mobile.md` 仍是 draft，TestFlight 验收未完成 |
| Factory / 定时任务 / 凭据库 / 群聊 | 未上线 | issue #191–#195、#179、#180、#105 均 OPEN |

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
