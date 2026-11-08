# #1506：独立 f132 Stop 验收准备（保持禁用）

本稿绑定应用源码 f132，尚未验证它的实际生产部署。Stop 十槽尚未生产执行；本次准备没有生产模型、Stop、SQL 或 cache 成绩，也不表示 #1705 已部署。四路径 overlay 尚未发布，没有正式 acceptance commit SHA。生产 alias、READY、公开版本与执行前后版本一致性均需由执行者最终核实。

## 应用与 acceptance 来源

- acceptance 基线：`058c01a15bbd9288544f9109bb05fc20b24036e1`，tree：`9dafdbbaf338ce9caa143c784b7859539da20e76`。
- 应用源码：`f1324dafa296f76289124bb93538f1938cb1597f`，tree：`b75d0b779a5bf849ffa06d02204c321e1c6fbd36`。
- f132 的第一父提交为 `3c32675c99d32f9c84a9b5e4bc48e59231baa4d8`。两者实际 Git diff 仅含 `.github/workflows/ui-policy.yml` 和 `docs/ci/1699-results.md`；前者只为两个 checkout 步骤添加 `if: always()`。这不构成产品运行逻辑变更。
- 9 个 numeric producer 在 f132 上全部逐字等于 3c，也全部逐字等于 `06173adb3fa75a4b7bfd9274efd873823f06d0ea`。12 个 live 来源与 3c 逐字相同，并逐项匹配已审 pin；实际 `coordinator-stream-client.ts` decoder 字节相同。
- 单独列出的 Stop、instrument、group、stream 来源及 `webSearchStep` 与 3c 逐字相同。与 `593c6c06dbb9717a4471b49d54ab4bfe2bfe8c9f` 的已有比较边界不变：7 个 numeric producer 整文件相同，`steps.ts`、`workflow.ts` 整文件有 GitHub context 相关差异；不声称二者整文件等同，也不声称 lazy discovery 已上线。
- 26 项保护文件中，25 项仍匹配原冻结 contract。MCP workflow 原样保留 058 字节，仍为 `false`，其 `MIKKA_ACCEPTANCE_SHA` 仍为 3c；本次不把 MCP 改绑 f132。

原 `prepare-disabled.py` 与 contract 未改。它的 `1a3ca56d62b8dff6bdb243eb98feca51347185e7` 祖先要求不适用于当前应用来源，原拒绝边界保留。此次独立准备使用实际 f132 源码证明，既不修改原 guard，也不把旧拒绝记录改写成通过。已经完成的 3c 准备目录保持原样。

## 四路径与关闭状态

当前 overlay 仍基于 058，仅包括 `live-source.mjs`、continuation workflow、本文件、`control/continue.json`。独立队列 `issue-1506-acme-acceptance` 与真实 Web job lock `web-deploy-production` 的规则不变。

C 保持 `enabled=false`、`expectedSha=null`、`phase=cache-live`、`cacheTurns=3`、`liveTabs=3`、`delayOneReturnedResult=true`。固定 workspace、fixtureRunKey、receipt/hash 与 Haiku/Luna 已选模型不变。没有启用 cache-live。

单独的 Stop matrix 与原已审模板仅有 APP_SHA 绑定差异：`APP_SHA=f1324dafa296f76289124bb93538f1938cb1597f`，`ACCEPTANCE_SHA` 仍为空，job 条件仍为 `false`。执行者发布实际 source overlay 后，才能绑定真实 acceptance commit 并决定启用。MCP 和其他控制维持已有关闭状态。

## 原 Stop 十槽及判定规则

Haiku 与 Luna 各有 ordinary-stop、before-tool、during-tool、group-public、group-private 五槽，共十槽。原 driver 提示、固定 fixture、三消费者与发送预算不变；每槽最多一次用户发送，不自动重试、不补跑。失败、未发、未覆盖均留在原分母。

before-tool 在第一条真实 `web_search/running` 后立即正常 Stop；during-tool 在同一事件后仅一次固定 600 ms timer 再正常 Stop。600 ms 只是客户端触发规则，不能证明工具主体已进入或尚未完成。group-public 和 group-private 分别继续采用原 responding_bot、private_generation_receipt 边界。

实际分类依赖精确 deployment、workflowRunId、call 和服务端终态。before-tool 必须有唯一 start/finish、finish 明确 stopped 且无矛盾 body timing；during-tool 必须严格满足 `toolStart < serverStopRequested <= serverStopAck < toolEnd`。工具先完成、部分重叠、边界相等、重复 attempt、缺 terminal/finish 或 scope 不符不能算请求目标通过；记录实际分类，并保留目标未覆盖。禁止跨 runner/服务端时钟相减。

真实工具 terminal 后才按原规则执行 eligible case 的一次严格 SQL 审计；group terminal 必须在 session.close 后。最终还须确认 Stop ACK、正文与 stopped marker、终态、没有后续模型/工具及没有迟到追加。客户端断流或一次 idle 读取不能单独证明 provider 物理停止。已经进入的只读工具允许完成，随后不应启动新工作。

## 离线验证与证据范围

本轮仅允许新跑实际十个 copied driver imports、原 validateContinuation/fixture 校验、copied-source manifest 与实际 decoder 比对，网络尝试、driver 调用、模型发送均应为零。结果单独存放在 f132 准备目录，不能重标 3c 的旧报告。为执行原 HEAD 断言创建的本地验证 commit 不发布，也不能冒充正式 acceptance SHA。离线通过不等于 Stop 生产通过或实际部署已核实。

## 后续 cache 六槽规则（尚未激活）

若后续部署和来源核实并单独启用 cache-live，仍固定 Haiku 三轮、Luna 三轮，最多六次用户发送。warm 槽 H2/H3/L2/L3 逐槽判断 send→firstText≤3000 ms；失败、未发和未覆盖保留原槽，不补跑或挑选较快样本。三独立 live consumer 复用同六次自然短答，不额外发模型消息；一条模型失败不阻止另一条继续。

短答以新 committed、持久化回复/cursor、权威 idle 收敛后取消本 reader，不声称自然 EOF。API/live 消费者证据不能替代 React 界面验收。数值归因须绑定实际 application、deployment 与来源；缺失不记零，不跨独立时钟相减，不相加嵌套跨度。本段只保留规则，没有激活记录或成绩。
