# Factory 交接必须有可视证据

- Date: 2026-11-08
- Source: Alex，在软件工厂验收证据对齐 Warp Factories 的实现任务中要求：
  「每个实现任务必须产出至少一段可视证据，默认录视频」「没有可视证据的候选不能进入『交给你』：服务端硬性拒绝，任务停在『阻塞』并写明原因，不允许用『未验证』顶替交接。」
- Rule: —
- Replaces: [2026-11-04-2200](2026-11-04-2200-factory-flow-like-warp.md)
  第 2 条中仅 UI 默认录像、以及拿不到可视证据仍可标为未验证并交接的部分。
  其余流程、一次审阅、人决定与合并、完成定义和 Artifact 展示规则不变。
- Issue: [#1783](https://github.com/alexj11324/Mikka/issues/1783)

## 决定

1. 每个实现候选至少有一份当前实现 run 产生且已保存的截图或录像，默认录像。
   改 UI 时记录真实运行的应用；后端和 CLI 记录实际测试运行或接口调用结果；
   文档记录渲染后的页面。文本日志、验收报告、审阅者截图和旧候选媒体不能替代它。
2. 服务端在进入交接、重试交接、审批和合并入口执行同一证据门禁。
   没有可视证据时先持久化阻塞及具体原因，再返回拒绝；重放事件和恢复路径也不能绕过。
   单项验收标准仍可如实标记未验证并解释原因，但候选的可视证据义务不能标记未验证后跳过。
3. 录像通过 FFmpeg 后处理去掉动作之间的空白，保留动作全过程、开始画面和最后结果，
   重映射步骤时间。只依据完整的实际动作时长裁剪；旧录像缺少时长时保留完整时间轴，
   不猜测哪些画面可以删除。压缩超大录像，发布大小仍遵守 run captures 的 100 MB 视频上限。
   处理失败时不发布原始超限文件，不以截尾凑大小；候选保持阻塞。
4. 证据继续使用 run captures、原有对象存储和可撤销分享链接。标题、步骤、报告沿用现有
   脱敏规则；文字脱敏不等于像素脱敏。录像和截图中的密钥、个人数据必须在公开之前审查，
   验收优先使用合成或已脱敏数据。没有明确可公开声明的媒体保持私有。
5. 仓库候选的 PR 描述包含同一候选的可公开截图、录像链接。服务端确认 PR 正文回写成功
   后才允许交接；链接撤销、证据不属于当前候选或正文回写失败都会阻止交接。
   不把私有下载地址、上传签名、凭证或原始日志中的个人数据写入公开正文。
6. 验收报告 Artifact 和任务对话引用同一份媒体和候选身份，提供媒体类型、时长及大小供
   内联显示。展示由现有客户端负责，不新建第二套存储或验收页。
7. 审查 agent 的结论仍是建议，由人作决定；产品内 factory agent 不获得自动合并权限。
   开发仓库的 issue owner 发布职责仍按 AGENTS.md 执行。

## Warp 对照的边界

[Warp Factories](https://www.warp.dev/factories) 将每个 agent 在 PR 前用 computer use
捕获截图或视频列为能力；[computer-use 验收说明](https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-computer-use-verification)
和[录制文档](https://docs.warp.dev/agents/capabilities/computer-use/testing-and-recordings/)
说明可视验证与后处理；[PR artifacts 文档](https://docs.warp.dev/agents/capabilities/computer-use/artifacts-in-prs/)
区分私有 Link only 和公开 Embed。

本决定把 Alex 的要求落实为所有实现类型的服务端硬门禁，并要求公开链接经审查。
这比 Warp 文档中允许标注未验证以及后处理尽力而为的配方更严格，不能把它们描述成
Warp 已保证的服务端行为。阶段、收件箱、原请求处沟通、Runs、证据、交接和完成定义的
逐项现状与差异保存在 #1783，UI 展示由独立的 Claude 会话负责。

## 数据与验收

- `submit_result.visualEvidence` 只接受 `{captureId, publicSafe:true}`；服务端从当前 run
  的 ready capture 解析字节收据，不接受 agent 自填公开 URL。
- 分享复用 `run_capture_shares`；证据及 PR 正文确认收据复用 `factory_events` 和
  `run_publications`。`run_capture_steps.durationMs` 为可空的追加字段，兼容旧数据。
- 数据库回归必须覆盖缺媒体拒绝且持久阻塞、视频交接、PR 正文与报告同源、跨候选拒绝、
  分享撤销和重试。真实 FFmpeg 回归覆盖超限输入、去空白、压缩、时间轴重映射和保留尾部。
