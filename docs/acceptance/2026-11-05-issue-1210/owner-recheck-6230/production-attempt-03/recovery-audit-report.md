# ALEX43：环境恢复后新查询的当前证据

**当前仍未通过：verify / failed，revision22，Owner acceptance=0。** 本目录记录一次新的只读数据库快照，实际时间为 **2026-11-06T01:39:10.493Z–01:39:10.524Z**。没有重跑Mikka任务、没有新模型运行，也没有修改生产数据。

## 时间与证据边界

环境更换后，原未发布的attempt03本地文件不可访问，旧functions.store也已重置。01:14的终态审计仍是本会话先前实际观察并报告的历史事实，但其原始响应现在不能从旧目录取回。

本次经过root明确授权，以已发布a0318e023f27d4773ce7e60512cf6aa9e7f648b8中的实际SQL和固定源码列映射建立新的有限查询。完整响应先保存functions.store，再写入新目录。**没有把01:39查询改标为01:14，也没有声称重做旧168项前后比较。**

01:14之前的restored-before完整原件同样暂不可访问，因此本目录的设置和七份报告是新的当前基线；当前指纹可如实列出，但不把消息中的旧指纹手抄成可复算的旧原始报告。

## 一次只读事务的范围

事务启动01:39:09.035Z，返回01:39:10.609Z；数据库各行actualQueriedAt从01:39:10.493Z到01:39:10.524Z。事务包含SET TRANSACTION READ ONLY、SET LOCAL statement_timeout=5s与16条明确作用域的SELECT，未调用provider refresh、模型、浏览器或写入接口。

读取包括原task/epoch/candidate、全部7个attempt/run身份、7份完整报告、pos6/7全部4对artifact/repository实际IO、两个实际hostEvidencePrompt片段、旧verify问题八NULL、原nativeask完整input含summary、原producer公开receipt、父机、计数、原anchor与实际retry回执，以及当前工作区设置。没有扩大为全部历史工具流或凭据内容查询。

SQL依据与变更均保存在query-provenance.json及sources目录。公开旧SQL中的Owner占位符副本没有直接执行；本次以已有授权的准确Owner/task/workspace重建新查询。

## 当前七份报告基线

| position | run | Factory attempt | 原生状态 / stopReason | 本次原始reportFingerprint |
|---|---|---|---|---|
| 1 | `6658f0ef-d446-4d8f-813d-7b7734bb02f3` | waiting | stopped / asked_human | `0cead4fbbb809e52fb255fb69195e5a2` |
| 2 | `d5cc2bb2-eb0c-44cf-945d-31a0b9fe0a11` | passed | succeeded / submitted | `5062d38944649948b1340c430f289e03` |
| 3 | `6fc099f4-8f04-47b1-8be8-f95edd54fde0` | passed | succeeded / submitted | `b4929bfc76737566bc1deeabb5f75a34` |
| 4 | `f5269f72-0103-4d34-864a-0018c60195fc` | waiting | stopped / asked_human | `cf7aeb42f3ad41ca0e9c64bcd76309b0` |
| 5 | `af4309f0-c48f-463a-8552-1b04c6e33595` | failed | succeeded / submitted | `f5592902b28ecb8fb0576e97aa024063` |
| 6 | `4c609155-c3cb-4c1a-81cc-dfa85f26eadc` | passed | succeeded / submitted | `cb5e98c828706a2d29e17f3412615514` |
| 7 | `0fad0e8b-1ea8-40b2-8e78-40b8b09a515a` | failed | succeeded / submitted | `4042668ddd9c45cb9b21f703b66eeb52` |

所有fingerprint均直接来自01:39原始响应，没有补齐、长度修复或另用客户端序列化代替数据库原值。seven-report-baseline-013910.json保存全部七份完整report JSON与当前保护状态，下一轮需再次实际读取并与这份新基线比较。

## 两阶段实际工具与报告缺口

两阶段各有独立的inspect_artifact与inspect_repository输入/输出，4对toolCallId唯一配对、时序正确。对两份实际contentUtf8独立复算均为52 bytes、3个LF且含最后LF、无BOM，SHA256为`05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`。实际输入都含完整expectedUtf8，输出head/committedSha256/contentMatchesGit/matchesExpectedUtf8满足原文件要求。

两次repository comparison都是`054e64ce6167427aecf937e6dc2410af677df32d`→`d05417e7848871e511141e10a282ffb7998b0a79`，完整changes仅有`A mikka-question-recovery-cc-20261104-1237.txt`，truncated=false。

| 阶段 | 工具 | 输入chunk | 输出chunk |
|---|---|---|---|
| review | mcp__mikka__inspect_artifact | `91b51be7-1789-4feb-ae3d-d4e634ae1aff` | `2cda993a-6c02-494d-9630-133ae16986f4` |
| review | mcp__mikka__inspect_repository | `48cc61f1-56a1-4b1f-974c-294586b8a311` | `a4ac1096-1ca9-4853-8c76-b67d6bf6eaf2` |
| verify | mcp__mikka__inspect_artifact | `2486f42f-4a0a-4519-ac5e-f67213596f58` | `1648f633-fdaf-4870-8476-92cd714618fb` |
| verify | mcp__mikka__inspect_repository | `917e6755-11ff-437b-97ff-899f70e60125` | `6a64a36d-fe2f-49cc-8f27-a605063fed81` |

这四对实际IO不覆盖报告失败判定。当前完整report仍保留两个原六项内的缺口：

- **原AC3：** review与verify都把整项标passed，却在evidence中承认没有独立观察nativeask的summary。当前重新读取的原始ask input包含560字符summary，真实inputChunk=`f1ae824b-71cf-4dfc-89f9-6c4ca134b5d3`，outputChunk=`fddaaa05-97f6-4227-9f8f-65f18ca998f8`。两个当前hostEvidencePrompt片段的nativeQuestion都没有summary，且不含该原summary全文。
- **原AC5：** verify报告第5条仍为false/unverified：它自己的freshartifact读取通过，但报告明确说未收到前review的实际artifact输出，无法确认review半边。保留真实false，不用审计者同时看到两阶段IO来改写模型报告。

hostEvidencePrompt是SQL明确定义的片段：从Host-recorded producer execution assignment起，到Producing run report之前；它不是完整prompt。因此缺summary的断言限于该片段及两报告自己的未观察说明。

两个宿主片段的producer实际native/API receipt均与本次直接读取的原producer receipt相符；lifecycle的canonical SHA256重新计算后与冻结digest均一致（5a197441…）。所提供绑定数据正确，不等于原AC3/5已闭合。

## 当前身份、机器、问题与设置

- 新review SID为`bcb2058a-8cfa-472f-a284-50bd70335ee9`；verify SID为`e04b9ce3-533a-4875-abbc-a7518893e82d`，两者互异且不复用旧五run的SID。retryOf/continuesRunId/questionContinuation均NULL。
- 两个新run的actualnativeclaim均匹配原producer的binding/connection revision2/claude_code_cli/claude-haiku-5-5；API=false，observedModel=NULL，未把requested alias当成provider实际观测。
- 当前review机器行ended/sandboxNULL，verify的同task VM `i773iwx0ulev7nvbomyyk` paused。同task VM转移允许；没有freshVM声明。
- 本次终态重读不能复原历史running时点。此前review曾采到running的历史观察仍仅按原时间记录；verify当时未采到running数据库样本，这项限制继续保留。
- 父机`ipa60du803guuiqnyzqan`当前sleeping、runtimeReady=true、deviceEnabled=true，lastActiveAt=`2026-11-05T14:48:42.215Z`。
- 原verify问题当前expired/revision3，八项答案或消费字段NULL；原到期时间与waitingBinding在新原件中完整保存。
- 当前ownerRecheckCount=1、普通retry/recheck control=1，全部attempt=7，activeRuns=0、activeLeases=0、acceptanceCount=0。
- 当前Model order只有原Haiku订阅条目，preferredHarness=claude_code；3个未归档Profiles均disabled。Bot聊天选择与其余设置全部作为01:39的新实际基线保存，不声称与丢失的01:03原件已经逐字段比较。

## 核心文件

- `recovered-read-response.json`：本次完整MCP原始响应，权威原件。
- `recovered-read-request.json`、`recovered-read-timing.json`、`recovered-read.sql`、`recovered-read-statements.json`、`recovered-query-index.json`：路由、精确SQL数组、时间与结果索引。
- `recovered-current.json`：原始结果按名称展开。
- `seven-report-baseline-013910.json`：新七报告完整基线。
- `stage-tool-pairs-013910.json`：4对完整真实工具IO。
- `host-evidence-013910.json`：2个实际宿主证据片段及冻结check。
- `original-native-ask-013910.json`：原nativeask完整input/output，含真实summary。
- `settings-013910.json`：当前工作区设置原件投影。
- `current-data-audit.json`：仅针对这次新快照的内容/绑定/身份核对，明确old168FieldComparisonReproduced=false。
- `manifest.json`：核心文件SHA256；原始响应与派生视图分别标记。

完整原始response/request/timing及解析结果已分别保存在本子代理functions.store的a43_recovered_production_response/request/timing/results。该存储只作当前会话内副本，跨环境重置或其他代理访问不保证可用；本次旧key丢失已说明这一边界。

本次恢复读取只有1个生产只读事务；生产写入、provider refresh、Mikka模型触发、浏览器动作均0。有限重取完成后停止生产读取，后续仅等待root下一次明确授权。
