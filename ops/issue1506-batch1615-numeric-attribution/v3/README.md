# Batch 1615 离线归因器 v3：cache-live envelope 修正

本目录是独立 v3 候选；父目录的 v2 源、日志、manifest 和 v1/ 全部保持原字节。无 Git 写入、生产查询、SQL、模型、CI 或资源创建。

## 输入的实际层级

phase=cache 时沿用原平面结构：
continuation.observation.turns

phase=cache-live 必须识别真实结构：
continuation.observation.phase = alex-cache-and-live
continuation.observation.observation.case = complete-short-turns
continuation.observation.observation.turns

外层 live envelope 另有 schemaVersion、issue、applicationSha、sourceCommit、fixtureRunKey、fixtureKey、status、modelMessagesAddedForLive=0、live。不能把 envelope 自己当作 runCacheTurns 报告。

v3 先校验 envelope，再解包内层 cache 报告。内外 applicationSha 对 expectedSha；内外 fixture key/runKey 对齐；inner.fixture 若已存在也必须一致。早期失败、尚未得到 inner report 或尚无 fixture 的失败零发送报告保留为六个固定槽中的未观测/失败，不生成虚构 run。错误的非空 inner SHA 或 sourceCommit 拒绝。

输出每个槽保留 liveEnvelope 的外层 status、cacheStatus、consumerStatus、modelMessagesAddedForLive 和 passed。即使 inner 三个 turn 都 observed，也不能把 failed/incomplete/running/missing 的 live 部分洗成 warm PASS。仍保留四个 warm 的固定分母与逐槽 ≤3000ms 门槛，不挑最快、不删失败。flat cache、ordinary-stop、日志解析、prefix、所有 attempt 及字段状态合同沿用 v2。

## sourceCommit 是独立输入

cache-live manifest 新增必填 liveSourceCommit，必须与 envelope.sourceCommit 及已有 live consumer report 的 sourceCommit 完全相等。它不是 numeric producerSourceCommit。

本次实际读取的已审 loader 为：
/vercel/recovery/disabled-preparer-batch1615/prepared/actual-ce67/payload/scripts/acceptance/issue-1506-alex/live-source.mjs

其中 LIVE_SOURCE_COMMIT = ce67afe931e9b9d6e7b0d346a62aa4d9751195c8；
prepareLiveSource 的 sourceBase 默认取此值，返回 sourceCommit: sourceBase。runLiveCacheTurns 的 sourceFactory 只传 sourceRoot，因此正常路径使用这个默认 pin。文件 SHA256 为 32d436e992ec7d3823f98cb497b56fcdb6c1ba7c27bc5035ed2e16fa991f08fd。

manifest.example.json 已填这个已审 live source pin；expectedSha/deploymentId 仍空，必须由根绑定实际验收。numeric producerSourceCommit 仍是 0d379dd92fd2d7b3f2b307030c3bcd8234426d0e，时钟解释不变。本次只读恢复磁盘源，不重新访问 GitHub 或生产；active acceptance head 5c18388 的合同由根已读源码指定。

## 使用与验证

node aggregate.mjs manifest.json report.json
node --test aggregate.test.mjs

只新增一项实际 envelope 回归，含合法嵌套六槽/capture 绑定、错误 inner SHA/source/fixture/consumer SHA、live 失败不洗白、早失败空报告、未发送槽的子断言。

完整 v2 原源码运行这项回归：实际 RED，unbound_capture_run，1 fail / 0 pass。
最终 v3 跑原 11 项 + 新 1 项：12/12 PASS，0 skip，exit 0。
原件在 red-v2.log、green-v3.log 及各自 receipt；未覆盖 v2 日志。临时 RED 源副本已清理。没有追加其他测试，没有真实生产样本。

继承 v2 的限制：真实 Vercel Markdown 未识别布局不推测；capture 精确 scope/版本/部署/hash 校验、missing/null/invalid/overflow、不同 clock 不相减等全部保留。新代码是离线分析器，不是产品修复，不要求 PG。
