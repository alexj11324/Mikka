# #1239 生产群聊创建验收（2026-11-04）

应用提交：`e9564639cd40f1433840c47662d8d548efc79144`。GitHub Actions **Web deploy 41881283360** 完成且成功，构建与上传步骤均执行；17:56:57.540 UTC 公开 `/mikka/api/version` 返回 HTTP 200、同一 build。

## 正常 Owner UI 创建

在已有验收工作区，使用新建菜单 → 新建群聊，输入 `PolicyV3 CC 20261104-1757`，仅选择本轮 UI / Coding / Testing 三个 Bot，点击创建一次。实际群聊 `0e4617b2-a68b-4187-9a3f-8c5584e0da62` 于 17:58:04.226 UTC 创建。17:58:10 的只读数据库核验确认同一 owner/workspace、三 Bot 与一个 Owner、lastPosition=0、groupTurns=0；页面显示空群聊与四位成员。创建本身没有额外模型对话或任务。

生产只核验本人正常入口和成员范围。跨 owner/cross-workspace 拒绝的真实 PostgreSQL / HTTP 回归在 PR 的本地证据中，不冒称生产执行过该负例。

## 后续 #1209 普通群聊（仍非 Factory 验收）

同群聊依序三个用户消息全部终态 complete：
- 闲聊：ignore，零 responder/wake/generate/publish。
- UI 职责问题：仅 UI 成员，实际一条回复。
- 明确 @ Testing：数据库保存结构化 member mention，仅 Testing 成员，实际一条回复。

最终共五条消息（三用户、两 Bot），group_task_bindings=0、group_task_receipts=0、这三个 Bot 的 agent_runs=0。两条实际回复的 turn 冻结模型均 `claude-haiku-5-5`、`claude_cpa`、原授权订阅 revision 2；绑定和发布回执在 JSON 中。内置 Decision 回执的 model、providerGenerationId、requestDigest 单独保留，不把其 generation ID 冒充为 Claude CPA 的 ID。CPA 回复的独立 provider generation ID / 费用未取得，记 unknown；普通群聊不声称原生 CLI claim。这份普通群聊记录不证明 Factory 三阶段或 Owner 验收通过。

三个普通群聊消息在 e956 页面提交；之后 18:06:59.779 UTC 发现仅停止工具说明的 #1240 已部署为 f2db127，正常刷新后继续准备后续验收，未改写前述版本证据。

## 文件与边界

- `deployment.json`：工作流步骤和公开版本。
- `created.json`：生产创建时间、owner/workspace、成员与零 turn。
- `cc-silence.json`、`cc-role.json`、`cc-mention.json`：实际三次 group turn 决策/响应身份。
- `cc-messages-and-zero-tasks.json`：实际消息与零任务。

初次发布本证据包时，生产截图文件尚未同步成功。随后三条普通群聊的原始实屏完成同步，现补附 [cc-three-group-cases.png](cc-three-group-cases.png)，SHA-256 `b98f553e600d8855d4110cd8cae71924d0643e473fdb0e0241971cbff672a0f5`；这是该生产群聊的真实截图。创建完成时的空群聊截图仍未同步，因此不声称已附该创建瞬间的 PNG，也未用本地截图替代。PR 的独立本地 production-build 十张截图仍在 evidence/1239-web-group-create-20261104，精确应用 head 56bffda1。

本目录仅为证据，不改变应用或生产数据。没有私密凭据、cookie 或 token。

