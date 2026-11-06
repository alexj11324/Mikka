# A43 attempt02 新 review：原合同与报告语义审阅

审阅范围：只读原 A43 issue 全文、固定候选、本次实际 report/artifact I/O/tool index、宿主冻结证据和历史 native claim。没有改报告、改状态、重试、启动模型或执行 Owner accept。

## 当前结论

`af4309f0-c48f-463a-8552-1b04c6e33595` 确实完成新的独立 artifact 检查并 submit；但宿主在 2026-11-06T00:05:21 的实际状态是 `review / failed / revision 16`，attempt `f23b075b-992a-4e17-b891-1c462d4d3738` 为 failed。agent run 的 `succeeded / submitted` 只表示成功提交报告，不代表 review 通过。报告新增两个 `unverified / passed:false` 项，故没有进入新 verify。不能据 UI 的提交完成状态或本审阅意见执行 Owner accept。

两个问题必须区分：

1. **Provider observed alias 非 NULL 不是原合同要求。**原合同要求原官方 Claude Code 订阅与冻结 Haiku。实际 native claim 可以证明绑定、账户连接、route/model、非 API 来源；它不证明供应商内部 alias。原生 telemetry NULL 必须原样保留，不能升级成额外验收前提。
2. **仅新增并交付目标文件是原标准 1 的真实要求。**原标准没有指定独立 checker 执行 `git diff 054… d054…`，且明确不给 Bash/verify_command。当前检查工具没有最终 commit 的 changed-path 集合，报告也未实际读取它；因此真实问题是缺少可用的只读 scope 观察，不能把该原要求删除，也不能通过强令运行未授予命令解决。

## 实际读取的依据

- `../1210-a43-audit/before.json`：直接读取 `originalIssue` 完整六项与前置模型约束；`originalAssignments` 四个旧 run 的实际 native claim 字段。
- `../1210-final-acceptance-review.md`：原合同与宿主历史基线的独立审阅记录。
- `attempt02-proof01-response.json`：数据库时间、实际 task/attempt/run/report、固定 assignment、真实工具 I/O。
- 同一原件提取的 `attempt02-review-report.json`、`attempt02-artifact-pairs.json`、`attempt02-host-evidence.json`、`attempt02-tool-index.json`。
- 固定生产源码 `1846002bec14c649e4bead67f136014141f4d133` 的 `lib/factory/checks.ts` 与 `packages/daemon/src/agents/mikka-mcp.mjs`。这些只用于判断当前可见证据能力，不替代实际工具调用。

## 原六项逐项映射

| 原条款 | 本次新 review 的实际证据 | 结论与边界 |
| --- | --- | --- |
| 1. 仅目标文件，精确 52B / UTF-8 / LF / hash | 新 inspect_artifact 输出完整 expected、bytes=52、正确 sha、固定 HEAD、committedSha256 相同、contentMatchesGit=true、matchesExpectedUtf8=true、textUnavailable=null。 | 内容和单文件 Git 绑定已实测。前驱 Git status 证明提问前仅目标文件变更；该工具不提供最终 candidate commit 全部 changed paths，最终仅目标文件的 scope 观察仍缺。 |
| 2. 提问前真实 Bash 创建/读取/bytes/hash/Git 范围与退出状态 | 三对原生 I/O 已完整随不可变恢复回执送入新 prompt；报告逐一引用 `bb4083b9…`、`27c90934…`、`202b7cf0…`，各实际 exit=0。 | 本次报告对该项的判断有真实来源，未冒称重新运行。这里的 Git status 是提问前状态，不能重命名为最终 commit diff。 |
| 3. 精确 decision 问题、结束执行、等待 Owner | 宿主 lifecycleComplete=true；真实 ask_human 输入精确问题、输出 Recorded/End turn、question/wait 事件、stopped/asked_human 的闭合 stream 均提供；报告引用真实 toolCallId/outputChunkId。 | 有对应的真实历史证据，不是只有 producer summary。 |
| 4. 正常回答后同任务/SID继续，只 submit 保留文件，不重跑文件操作 | 原 human answer、question_resume 回执、源与 producer 同 SID；producer seq1–20 闭合完整索引只有 ToolSearch 与 submit。 | 支持“已观测的原生继续执行没有重跑这些命令”。索引不是 OS 审计，不能扩写成对所有未观测副作用的绝对保证。 |
| 5. 新 review 与新 verify 各自固定候选、fresh artifact I/O | 新 review 实际输入 `d40371c8-e3c4-48d4-b081-cf30d849923f`，输出 `7b058789-b30c-4cee-b427-b1a4b4c720cf`，00:03:20.643 → 00:03:21.354；完整 expectedUtf8 正确。 | review 这一半已满足。新 verify 尚未发生，整体条款未完成，不能沿用旧 verify。 |
| 6. 引用严格回执绑定的直接前驱来源，保留历史身份与时间 | 三条 questionCommandSources 的 source run / 原 SID / stopped / candidate SHA / recoveryEventId 精确；observation watermark source29、producer20、digest `5a197441…`；报告引用实际 output IDs。 | 新 review 有正确引用并明确 inherited/pre-question；新 verify 的同等要求仍待执行。 |

固定候选仍为 `2f338962-c690-4ba7-bc63-6c73a9de3acb`，交付 HEAD `d05417e7848871e511141e10a282ffb7998b0a79`。artifact 本体完整内容是 `mikka-group-policy-v3\npath=claude-code\nstatus=ready\n`，SHA256 `05767473d01dff511a6e38e59e8e3730f7e114283c2494c6b6ac48fadcb382a6`。

## 原订阅事实与 prompt 的可见性边界

直接读取 `before.originalAssignments`，提问前执行 `6658f0ef…`、producer `d5cc2bb2…`、旧 review `6fc099f4…`、旧 verify `f5269f72…` 四行均实际具有：

- native claim binding `0e5edf2d-2653-475e-8693-b53ceafa7c11`；
- connection `93b6ab23-900b-4e18-9ea0-baccf2d104ce`，revision 2；
- route `claude_code_cli`、modelId `claude-haiku-5-5`；
- `apiClaim=false`，`providerObservedModel=null`。

本次新 review 的 sample02 / proof01 同样具有这套实际 native binding 与非 API 事实，新 SID 独立。这里可以说是宿主记录的原订阅路由和冻结模型；不说已经观测到供应商内部 alias。

但当前 `checks.ts:295–297,388–389` 放进 checker prompt 的 producerExecution 只有 runId/sessionId/status/model/harness/observedModel，没有实际 native claim 的 binding/connection/route/non-API 元数据。报告对 subscription 缺观察的疑虑不能简单归咎于忽略了这些原生证据，因为这些字段并未通过该投影送给它。需要补充真实、绑定到 producer 的最小宿主事实，并继续明确 observed alias 的限制；不能填一个伪造的非 NULL observedModel 或预先给 pass。

## Git scope 能力边界

`inspect_artifact` 精确读一个文件及其 committed 内容，无法给出全部 changed paths。`inspect_repository` 的现有实现提供固定 HEAD、sanitized origin、当前 working-tree status 和目录清单，也没有 parent/base commit comparison。因此即使让模型补调用目前的 inspect_repository，也不能把“工作树 clean”冒称为“最终 commit 只改了目标文件”。

合理补全应是固定 worktree 内、显式校验完整 SHA、只读且有截断标记的 commit scope 观察。原始状态、失败报告和证据应保留；后续正常检查根据真实观察自行判断，不改写本次 failed，不切模型/来源，不跳过 verify 或 Owner 阶段。

## 与启动记录的关系

初始 install_computer 超时和 preloaded.pid 警告已另记 `attempt02-startup-classification.md`。同一工作流后来实际领取并执行，启动问题不是本次报告失败的原因。新 run / 新 SID 复用同任务 artifact VM 的事实必须保留；fresh VM 原要求针对先前四个 NEW tasks，准备文案的加强假设已明确更正。

## 引用质量补充（不补写模型证据）

报告 criterion1 中出现 `run-chunk:bb... not needed` 这一不完整 placeholder；它不是可解析的来源 ID，且 printf 创建记录不能当作首字节读取。该片段不计作证据，也不改写成完整 ID。该 criterion 后面另有真实完整的 `27c90934-986f-4574-9e46-df0706395559` BOM 观察引用，criterion3 完整引用了三条 Bash 输出；新 artifact 工具的完整 UTF-8/bytes/hash 也独立存在。最终报告应保留这个引用瑕疵，不能说所有引用都无瑕疵。

独立 audit 随后提供 `attempt02-host-artifact-comparison.json`，131 项与原始基线比较无差异，并按部署 evidence.ts 的 canonical 顺序精确复算冻结 digest。此项佐证实际宿主已经提供完整问答/命令记录，不会消除上述最终 Git scope 能力缺口或未执行的新 verify。
