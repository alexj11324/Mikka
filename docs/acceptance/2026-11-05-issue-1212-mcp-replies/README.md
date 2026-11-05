# #1255 MCP 回复推送：main 整合与验证

本证据包对应 [PR #1255](https://github.com/alexj11324/Mikka/pull/1255) 的代码提交 **`8b1bb0590eb16f0ceec9e4458ae0656b6bacfb25`**，Git 树 **`03cbf36739520687aa790d4d29ac683e9a1d2d15`**。PR 保持 draft，未合并、未部署；生产真实行为、固定任务一小时前后对比及三条模型路径仍未验收通过。

本次只推进 #1212 A 组的 MCP 回复等待：原 2 秒数据库轮询改为现有 LiveChannels 通知唤醒，并保留 15 秒回复补读、原 90 秒总截止时间和截止时的最后一次权威读取。15 秒规则只适用于回复等待，没有更改 stop、pause、revoke 或 approval 的生效时限，也没有宣称健康连接下零数据库读取。

## 版本与 PR 范围

| 项目 | 精确版本 |
|---|---|
| 原 #1255 head | `4cbe8e04e3ce7eb35398fa67321fb70f584081a1` |
| 原 own commit 的父提交 | `9219c729df2dbcee55ad9b5520fee1edc8afcf1e` |
| 原 stacked base（#1236） | `3f42627321479e9d9071143dc7ca133c2034c56d` |
| 第一轮整合 main | `a18d22a9d4b6b067297a72eb37205493be4f0b2b` |
| 最终代码整合 main | `3adee90c742b045e0eebd5854eecc6ade1c84aae` |
| 最终提交的两个父提交 | 原 `4cbe8e04…`、main `3adee90c…` |
| retarget 后观察到的 main | `efef5b5a5a8a55deb3c504b05fb736d4003e942c` |
| GitHub 当时生成的合并预览 | `5b8c16147bc8fc92e238578b088d682ee1be9c9d` |

将原 head 的单个 own commit 应用到 main，再按两边实际语义解决冲突。没有合入 #1236 未上线的任务面板、批量 writer、`issue_document` 或 stream batching。最终相对 main 的净改动仍是原来的 **15 个文件**；原 PR 历史通过普通 fast-forward CAS 更新保留，没有 force push。

递归读取了 GitHub 上最终树及其 main 基树，两者均 `truncated=false`。最终 4,576 个叶节点与 main 4,570 个叶节点完整对账，差异恰为本 PR 的 15 个路径，所有其余叶节点保持相同。15 个目标 blob 与云端文件的 Git SHA-1、SHA-256 和字节数均一致。五个共同数据库/频道模块与 main 逐 blob 相同，未复制另一套事务或订阅实现。详见 [publication-proof.json](publication-proof.json) 与 [metadata.json](metadata.json)。

`efef5b5a…` 是随后上线的独立 question-wake 功能。实际 GitHub 合并预览 `package.json` 与该 main 逐 script 比较后，只多本 PR 的两个测试入口；所有 question-wake 测试命令均保留。PR 当时 `mergeable=true`，`blocked` 表示仍受检查及 draft/验收门槛约束。

## 行为和交叉修改

- `coordinator_session` 使用持久 Bot UUID；作用域由当前认证 Owner、该 Bot 的实际 workspace 和 active membership 决定。通知只传 kind/id，回复内容仍经普通权威读取。
- 先登记订阅，再读取回复。在途读取收到事件后保留 dirty 标记并补读；突发通知只合并并发工作。
- `takeInbox`、`appendMessages`、`releaseLease`、`failTurn` 与 schedule report 在真实最外层 COMMIT 后通知；回滚、错误 lease holder 和幂等重放保留原门槛。
- main 新增的 `bot_chat_list` 消费者完整保留。列表通知仍有自己的普通续租去噪条件；MCP 的会话状态通知没有借此扩大列表重读。
- 真实延后调度保留发起请求的数据库上下文，完成后重新解析作用域。MCP 请求取消只回收自身等待、计时器和订阅，不更改任务状态或 Coordinator lease。
- 使用 main 的 `live_ready` 能力握手，并为服务端 LiveChannel 提供单调时钟。Worker 必须实际声明支持 `coordinator_session`，不能仅以 WebSocket 在线或 pong 宣称支持新事件。

## 实际验证与失败保留

所有执行均位于已有的 8 vCPU / 16 GiB Vercel 云端 Linux 沙盒，Node **24.22.1**、pnpm **10.34.3**、PostgreSQL **17**。每轮使用唯一 loopback 数据库及临时角色，临时口令只在进程内存、子进程环境及本机角色设置中使用，未输出到代码或本证据包。`@mikka/protocol` 的实际链接指向本轮 worktree。

| 阶段 / Git 树 | 真实结果 |
|---|---|
| a18 初次整合 `d5f33184…` | reply wait 11/11；schedule PG 11/11；Coordinator 341/341；schedule 15/15；typecheck/lint 通过。MCP PG 8 pass / 2 fail（一个子例及其父）；gateway 66 pass / 1 fail。 |
| 3ade 首次整合 `2c484ecb…` | reply wait 11/11；schedule PG 11/11；gateway 67/67（9+48+10）；Coordinator 341/341；schedule 15/15；typecheck/lint 通过。MCP PG 4 pass / 6 fail（五个旧预期及其父）。 |
| 最终树 `03cbf367…` | **MCP 真实 PG + workerd 10/10、0 skip**；类型检查通过；完整 lint 通过，含 migration 55/55。 |

第一类失败是旧 fixture 将新 `live_ready` 握手帧当作业务失效事件。修订后先精确断言实际能力帧，再检查业务消息。第二类失败来自 main 的新列表消费者：一次回复提交现在产生合法的 `bot_chat_list` 与 `coordinator_session` 两类通知。修订后的 fixture 对完整事件列表做严格比较，而不是过滤未知事件；主线的权限、回滚、lease 和取消断言均保留。

最终一轮只修改 MCP PG fixture 的这些预期与准确的数据库诊断标识；其他生产模块 blob 与 `2c484ecb…` 相同。最终树重新运行了该真实 PG 套件、类型检查和完整 lint。未把前一版本的结果标成在最终树重新执行。全部源差异及原始失败/通过日志随包保留。

10 项真实 PG 计数包含一个父测试和九个子测试：实际外层 COMMIT、savepoint/外层回滚、take/release/fail 的真实写入、独立应用进程通过真实 WebSocket 交付、schedule 报告、Owner/workspace 隔离、撤销 membership、跨数据库延后 resolver、取消后 lease/run 不变。工作负载中的计时单测和这些本地数据库实验不构成生产一小时观测。

## 清理

三轮 driver 都正常退出，分别保存 identity/setup/results/cleanup 回执。外层自有数据库使用普通 `DROP DATABASE` 删除，删除前均无 client backend；临时角色随后删除。最终 catalog 查询显示这些角色没有剩余自有数据库。嵌套跨数据库 fixture 使用仓库原有、带目标检查的 `dropTestDatabase` helper；该 helper 的 `WITH (FORCE)` 行为没有在本 PR 修改。

| 阶段 | 自有角色 | 外层数据库 | 清理完成 UTC |
|---|---|---|---|
| a18 initial | `mcp_reply_48a03e99ee41` | `mcp_reply_48a03e99ee41_e2e` | `2026-11-05T00:56:04.366Z` |
| 3ade integration | `mcp_reply_2d64d77818fb` | `mcp_reply_2d64d77818fb_e2e` | `2026-11-05T00:59:28.660Z` |
| 3ade final | `mcp_reply_019b15311942` | `mcp_reply_019b15311942_e2e` | `2026-11-05T01:01:25.681Z` |

没有停止共享沙盒、修改共享 PostgreSQL 权限或操作其他执行者的数据库。没有付费模型调用、生产数据库写入或部署操作。

## 待完成

本包同时记录精确 head 的 [GitHub CI 回执](ci-exact-head.json)：2026-11-05 01:13 UTC 读取 `8b1bb059…` 的全部 35 个检查，29 success、6 个条件 skip，0 fail、0 pending。检查成功不等于应用或 Worker 已部署。

仍须按 issue 正文完成固定任务一小时前后数据、三条真实路径及生产验收。生产阶段需要匹配的 Web deploy/public build、支持该 kind 的实际 gateway 版本，以及真实账号下的作用域和取消行为。上述门槛未满足，本 PR 不作为 #1212 A 组整体完成的证明。

Related tracking issue: #1212
