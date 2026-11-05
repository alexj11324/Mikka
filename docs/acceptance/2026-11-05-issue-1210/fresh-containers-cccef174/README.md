# #1217：与 fc2 主线整合后的最终证据

最终代码提交：`cccef174f7a4e604a820a4b61f8521e8cdba100b`。PR：[1217](https://github.com/alexj11324/Mikka/pull/1217)。

基线为 `fc2d401bde7b3f567b1288b01accd6fdeb433d0c`，最终完整 tree 为 `b7ace3493dbe0aad258eaaa245b528fdc95fcc32`。GitHub 完整递归读回 5,221 项且未截断，逐项核对本 PR 的 27 个路径：26 个内容文件与 1 个删除；同时比较完整基线 tree，未发现清单外的文件差异。

## 源码整合

此前已验证的 `c60850b` 与主线 fc2 正常三方合并，得到中间 tree `ccf5f3b`、提交 `aaf5256`。原 PR 的 task-machine 与 package 两个相关文件继承主线新增逻辑，其余原有内容 blob 和删除保持不变。

主线 #1288 的 provisioning lease 私有证明、基础设施失败后可重试的语义、先清理并调用 `afterRunEnded` 再唤醒 Coordinator 的顺序全部保留。新任务仍从官方模板启动，原生问题续跑仍绑定实际 retained VM、Owner / workspace / Bot、device、repo 与 session；没有恢复父电脑 running 的前置门槛。

中间提交 CI 随后发现主线新增的 `run-end-paths.db.test.ts` 仍提供已删除的 `snapshot` provider 属性，导致 TS2353 类型错误。最终提交只删除这一行过时的测试 stub，没有改变产品逻辑，也没有删除相邻 connect / create / kill 断言和真实租约、Owner stop、重试隔离断言。`final-fixture-comparison.json` 保留 GitHub 实际提交比较；独立评审重新核对了这一次删除。

## 当前提交的实际结果

| 门禁 | 结果与范围 |
| --- | --- |
| GitHub 检查 | 2026-11-05 00:14:17 UTC 核对：26 项全部完成，22 success、4 条件 skip；无失败或待运行项 |
| GitHub workflows | 7 个运行全部 success；对应的原始 ID / URL 在 JSON 中 |
| fc2 集成专项 | Factory run-end / machine fallback 真实 PostgreSQL，加 cloud dispatch startup 编排单测，合计 49/49、0 skip；这是混合回归，不把全部 49 项称为数据库测试 |
| 最终一行测试修正 | Typecheck exit 0；真实 run-end PostgreSQL 12/12、0 skip |
| 最终 PR 差异检查 | 相对实际 fc2 基线的 `git diff --check` exit 0 |
| 清理 | 两个本轮独立测试数据库均删除并查询确认为 absent |

普通 CI 的 custody / runtime / browser 名称不代表已经运行付费云沙盒或三模型生产验收。4 项条件 skip 原样记录，未计为成功执行。

前一提交 c608 的较大范围原始门禁仍可在[历史证据](https://github.com/alexj11324/Mikka/tree/72343a341ef64a420205b3c800076736b95b64a6/docs/acceptance/2026-11-04-issue-1210/fresh-containers-c60850b)核对：Factory 135、provider recovery 7、cloud backend / unattended / task machine 62、正常 Owner answer 25、cloud limits 29 与 retained probe 11，均为零跳过；这些历史本地结果没有冒充当前 head 的独立重跑。当前 head 的 CI 已另行完整通过。

## 保留的失败与传输完整性

- 中间提交 aaf 的两个 CI job 均报告同一处 `snapshot` 类型错误：[Source checks](https://github.com/alexj11324/Mikka/actions/runs/41938519231/job/126953194315)、[backend](https://github.com/alexj11324/Mikka/actions/runs/41938519245/job/126953029149)。修正和最终真实回归见本目录。
- 以旧 head 检查整合差异时发现主线 #1285 测试已有尾空格，原失败日志保留。没有夹带修正无关文件；实际 PR 基线检查为 0。
- GitHub create-tree 曾返回 422 超时。之后通过预期 tree 的完整远端读回和所有路径 blob 验证确认对象实际已创建，再创建提交并用 expected-head CAS 更新分支。
- 本轮最终原始日志压缩包 2,103 字节，SHA-256 为 `f8090d0a0945753bbfc59c58ed887ecf013a2f532f3a6d4f2f3f49dec3e8107e`；按有序小块传输、校验长度及哈希后，仅提取明确允许的六个文件。主集成证据包 34,284 字节，SHA-256 为 `7b7ce57ead2702278276d50b78266c1f44c6fc1f08ced5827e228dc17895b0ba`。

## 未完成的门槛

本 PR 尚未合并、尚未部署，当前不存在这个最终提交的生产验收结果。

#1210 正文要求合并前跑真实付费 `test:local-loop` cloud leg。此前两次 API 尝试在前置阶段因余额不足停止，没有进入 cloud leg；指定 key 在 2026-11-04 23:45:39 UTC 的[免费余额查询](https://github.com/alexj11324/Mikka/blob/8925cd8f09dac0aaa101d01fc83c57dd31daac0a/docs/acceptance/2026-11-04-issue-1210/production-readiness-41935491849/prescribed-api-balance.json)仍为 `available=false`。查询前通过 `deepseek-flash` 模型断言，模型调用数为 0。

订阅 cloud leg 的正常 OAuth / custody 连接与受支持 driver 也尚未齐备。生产只读诊断登录的是另一个 smoke Owner，不能代表原任务 Owner 的订阅可用性，不能搬用该身份验收原任务。尚未通过正常原 Owner 登录完成原 CC Factory 问题的回答和后续验收。

补齐真实合并前门槛后，仍需按 Web deploy 工作流发布、核验公共 `/mikka/api/version.build` 精确匹配 squash 提交，并在父电脑 sleeping 的条件下分别完成 API `deepseek-flash`、官方 Claude `claude-haiku-5-5`、官方 Codex `gpt-6-luna` 的普通任务与 Factory execute / review / verify。不得把本目录本地与 CI 结果替代这些生产结论。
