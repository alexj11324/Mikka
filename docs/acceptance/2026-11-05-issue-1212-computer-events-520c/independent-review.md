# C / PR #1231：3ad 主线整合独立复核

审阅结论：在本次指定的整合范围内，没有发现阻断项。此结论是源码与既有原始回执的独立复核，不是重新运行测试，也不是合并、生产验收或性能门禁通过结论。

## 绑定版本

- PR：<https://github.com/alexj11324/Mikka/pull/1231>
- Head：`520c397e2f58cdc69dd5c6d75f6e8d83ffe2b103`
- Tree：`c342a69139192ce077a7738707aec788579c51e1`
- 比较基线：`3adee90c742b045e0eebd5854eecc6ade1c84aae`
- 双亲：原 C `b12750d5b7006c6dbc7c7b5bec7acf8ace1b51ed`、上述 3ad。
- 材料：`3ad-integration/metadata.json`、`source/`、`evidence/final-vs-main.patch`，以及其中三个 3ad 验证目录的原始日志。
- 通过 GitHub 亲取 PR 元数据和 29 文件列表。29 个本地源码文件的字节数、SHA-256、Git blob SHA 均匹配 metadata；GitHub 的完整 29 文件与 blob SHA 集合也与 metadata 完全相等。

## 主线能力没有被整合覆盖

`lib/live/events.ts` 保留 3ad 的 thread/task-run/bot-chat/issue/bot/group/workspace-settings 列表、computer-state、approved-write(s)、pending-actions、Factory、thread/run 类型，只追加 `subagent_events`。

`hooks/use-live-key.tsx` 对基线只增加 `useLiveScope` 导出。主线的 owner 变更重建 channels、workspace 实体作用域、deadline/observation 更新、共享 visibility、单调时钟、订阅句柄更新均保留；C 的共享 feed 按 channels 实例和 workspace 分开，不在不同 Owner 间复用游标或缓存。

`action-reviews.ts` 和 `credential-reviews.ts` 原有 `pendingActionsChanged` 调用保留。其他列表、approved-write、computer-state 的 producer/consumer 不在此次 29 文件 delta 中，没有用旧 C 文件替换它们。

## COMMIT、权限与上下文边界

- SubagentStore 的事件写入在对应业务事务内；本次序号锁在业务行锁之后取得并持有到 COMMIT，通知在成功 COMMIT 返回后调用。queued stop 也改为业务状态和事件同事务，事件插入失败不能留下已停止状态。
- 凭据提案保留原 owner/workspace/Bot、policy revision、epoch、target、已有 pending 动作检查；事件与 pending 行同事务。原 pending 失效通过其既有 after-commit 调度，新增事件失效在 COMMIT 后发送；回滚不会产生其中任一通知。
- Broker 的锁模块是纯数据库依赖，没有把 Next 或共享推送密钥移进隔离 broker。应用只在 broker 成功响应、状态允许且 origin 匹配后发送 subagent 失效；两个实际 caller 显式传认证 caller 的 owner/workspace。guarded、错误 origin、未知响应不提前通知。
- 新通知只含 `subagent_events` 和 workspace ID。`notifyLive` 的延迟工作没有重新读取业务数据库，因此此路径没有从已释放 held client 切到默认 DB 的额外读问题。已亲读 3ad 的 request-scope、commit-effects、notify 与 request-log 实现；本次没有修改它们。
- JSON 增量路由拒绝 Authorization 混用，使用 fresh cookie session，验证所请求 workspace 的 active membership，然后按 session owner 与 workspace 两列读取；保留 private/no-store 与十进制 bigint 游标。权限测试实际使用 BetterAuth 签名 cookie 和数据库会话撤销，不以 mock getSession 代替。
- 新 feed 的 hidden abort/迟到结果 generation guard、owner/workspace 缓存隔离、100 条分页、失败后 60 秒补拉，沿用此前 C 设计；无条件每秒服务端 SSE 查询已从路由移除。普通通知传输仍是已有 best-effort 通道，不能将源码审阅表述成已完成生产推送验收。

## 新 strict fixture 没有削弱旧断言

`lib/live/pending-actions.db.test.ts` 的实际 credential proposal 现在严格比较两条完整 scoped 通知：既有 `pending_actions` 和新增 `subagent_events`。排序仅消除两种 after-commit 调度的先后差异；仍对完整数组做 deepEqual，没有改为 contains 或忽略额外通知。重复提案的总数量保持不变；注入真实 event INSERT 失败后，两类均要求零新增，pending 行数和 subagent 状态要求回滚。

## 测试接线与原始回执

对 package.json 做了结构化比较：唯一脚本变化是 `test:live-db`，完整保留 3ad 的 9 个文件并追加 C 的 4 个数据库文件；其他 script 和 package 字段相等。run-db-tests 的四条 required-suite 记录均落在原 computer 区域，既有 marker/suite 未删除。focus policy 只迁移原那条窄例外到新的 visibility hook；没有扩大通用轮询或 focus 例外。

已阅读而未复跑的回执：

- 3ad 初轮 live DB：79 测试、76 pass、3 fail、0 skip，包含两项导入鉴权模块时 HTTP origin 不满足开发/CI 条件的子例和其父例；没有将其写为整套绿。
- 同轮 credentials：37 + 10 全绿、0 skip；Gateway：9 + 48 + 9 全绿、0 skip；event-stream：6 全绿、0 skip；lint/UI policy 中 55 项全绿。
- 最终 `c342a69` 的 CI=true 诊断：受影响 lists + pending 20/20、0 skip，typecheck/lint/diff-check exit0。
- 最终合法 HTTPS origin、去除 CI/local-mode 标志的独立回执：受影响 lists + pending 20/20、0 skip；原始初轮失败保留。没有将分批结果写成一次全套最终通过。

## 尚未覆盖 / 发布限制

- 本次是读源码、比对 blob 和阅读已有日志；没有重跑已绿测试、修改产品、调用模型或操作生产。
- 本次 review 绑定 3ad 整合。审阅时 main 已到 `efef5b5a5a8a55deb3c504b05fb736d4003e942c`（#1287）；其中 package.json 有独立 question-wake 接线。后续正常合并须保留该主线脚本，不能将此次 3ad package.json 整文件覆盖到新 main。
- 新 head 的 CI、本地 production build/截图、正文要求的完整改前/改后实际任务观测、Web/Gateway 发布与公开版本核验、真实生产行为仍由主任务单独确认。本报告不能代替任何这些门禁。

Refs #1231, #1212.
