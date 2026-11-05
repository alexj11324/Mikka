# Issue #1296：受阻独立审阅的可见性与恢复

日期：2026-11-05（UTC）。跟踪：[Issue #1296](https://github.com/alexj11324/Mikka/issues/1296)。

本文记录 [批次 PR #1336](https://github.com/alexj11324/Mikka/pull/1336) 发布后的生产复查、目标 RED 与本轮修复边界。[批次 PR #1353](https://github.com/alexj11324/Mikka/pull/1353) 的已验证代码 head 为 `bbf2f70087c459fd82fbc7a38d47c0402f990df6`。1cb 真实 UI 发现的线程通用 Retry／Send 缺口已完成目标 GREEN、真实 AFTER 与非空草稿验证；Docker checks/build 及最终 CI 通过，**代码与本地 UI 验证完成，可合并**。本记录收口时 PR 仍为 draft，证据提交、merge、部署及生产恢复待完成；各树结果不混用。本文不替代[既有生产验收记录](issue-1296-production-followup.md)。

## 1. 版本与生产事实

- 已发布并复查的 main：[`122fd9054b5400569fd2518f55c52cec8f04d28a`](https://github.com/alexj11324/Mikka/commit/122fd9054b5400569fd2518f55c52cec8f04d28a)，tree `307dfae06f922cfebe58d6926360833b62260dfe`。
- 复查使用现有已登录 Owner 的正常产品界面与只读接口；本节的界面检查没有发送新模型请求。
- Claude 案例为 `ALEX-60`。此前 execute 已成功，保留 41-byte 产物；独立 review 遭遇 Profile 准入拒绝，原错误为 `The selected Agent Profile changed or is no longer available. Select an available Profile for a new run.`，不能据此称独立审阅通过。
- 本轮 fresh GET 确认 Factory task、当前 review attempt、当前 check 均为 `blocked`；candidate 保留，`completionRecovery=null`。
- 当前 Factory 原因是 `Question recovery blocked: factoryQuestionRunMismatch`；原 review run 仍保留 Profile 拒绝错误。两者属于不同层次。
- 正常任务页的 Factory 验收整块消失，原执行线程也失去验收入口，没有“重新审阅”。候选并未消失。

对应记录：Factory task `3b026473-489c-4c1e-b120-e13fd84fee22`，candidate `0954eb56-77e1-48fc-8826-4229f797d052`，原 review run `9142a4fc-2136-4520-87ad-f4167d058be3`。

原 review 的 items 为空、错误为 Profile 拒绝，不足以单独证明所有“未执行”条件。恢复资格必须由服务端根据持久化运行状态、绑定和执行证据判定。历史额度快照时间未被采集，不能把此次历史失败归因为已证明的 60 秒 TTL 竞态。

## 2. 已确认缺陷与风险

发生与影响均采用 1–10 的审计评分；乘积用于本轮排序，不代表全站发生率。每项均有具体失败条件。

| 缺陷与发生条件 | 实际结果／根因 | 发生 × 影响 |
| --- | --- | --- |
| review/verify 已有固定 candidate，状态为 blocked | `candidateCheckState` 排除 blocked，`visibleAcceptance` 过滤后列表返回空；producer 线程使用同一过滤结果 | 8 × 8 = 64 |
| 受阻结果直接进入原验收 pane | `ResultLine` 将所有非 passed/failed 都当“进行中”并显示 Spinner；属于源码和交互 RED 确认的显示错误 | 8 × 6 = 48 |
| host Profile 拒绝的 run 为 failed/blocked，未建立真实提问会话 | reconcile 把 blocked 一律交给 question 记录，而该路径要求 stopped run 与有效 session，产生 `factoryQuestionRunMismatch` | 8 × 7 = 56 |
| 未开始的独立检查已使 v2 task 进入 blocked，Owner 尝试普通 retry | `factoryReviewPerformed` 把已绑定 run 的受阻 attempt 计入审阅历史，普通 retry 抛 `factoryTransition` | 8 × 8 = 64 |
| 明确 flowVersion=2 的已执行 failed review | UI 仍提供通用“重新审阅”，而单次审阅规则必然拒绝；该问题由源码与两条目标 RED 确认 | 8 × 6 = 48 |
| 从验收面板打开 Factory 独立检查的错误线程（1cb 新发现，bbf2 已获目标 GREEN） | 正常点击 Independent review 后，`IssueThreadPanel` 显示通用 Retry，Composer 仍邀请继续指令；后端排除 Factory review/verify/monitor 的通用执行入口。Retry 未点击、没有发送；bbf2 的能力投影与禁用已获回归、AFTER 及非空草稿 Enter/DB 检查支持，发布与生产恢复仍待补 | 8 × 6 = 48 |

权限、来源绑定与事务一致性采用严格拒绝条件，不依据风险乘积分数放宽。

## 3. UI 修复

- 固定 candidate 的 blocked review/verify 保留原 Factory 验收行、producer 入口和候选信息，复用现有 Panel、Pane、CandidateCard 与 ResultLine。
- 主状态为“审阅受阻／验证受阻”；独立结果使用静态图标和“受阻”，不再假装运行，也不把准入受阻写成内容审阅未通过。
- blocked 行不直接展示内部错误前缀。当前 Factory 原因放在现有 `RunErrorDetails` 的“详情”中；原 run 错误仍可通过“独立审阅”进入对应线程查看。
- 可见性不授予执行权限。只有服务端 `detail.checkStartRecovery.binding` 精确匹配，且 task、detail、ledger、最新 check 的身份、candidate、attempt、revision 和状态一致，才提供原“重新审阅／重新验证”。
- 普通 failed 重试保留原 `revision + 1 / pending` 回执。取得 host 资格的 blocked 恢复要求同 candidate、同 stage、新 attempt 为 running 且有 runId、task 为 running、`revision + 2`。
- 未确认的请求保留原 eventId；重新挂载、刷新和 live 通知不会自动重发。已知准入拒绝与未知请求结果继续使用现有“重试未完成／重试未确认”。
- canonical detail 明确 `route.flowVersion === 2` 且为 review/failed 时，隐藏必然被拒绝的通用 retry。缺省版本、flow 1、verify、合法 blocked 恢复和 `completionRecovery` 原路径保留。
- bbf2 的七文件增量由 host 按 `latestRunId`、owner、issue 与 `factory_attempt.stage` 投影 `replyAvailable`／`retryAvailable`。非 question 的已终止 review/verify/monitor 关闭通用 Retry 与普通 Send，并以中英文说明引导到 Acceptance；保留 R10 Composer、可编辑草稿和引用。活动消息、waiting 回答、questionWake、严格原 session Retry 及普通 execute 按既有准入保留，mutation 权限未改。源码：[能力投影](../../app/actions/agents.ts)、[线程界面](../../components/workspace/issue-thread-panel.tsx)；目标 GREEN 与下述实测相互补充，不代替生产恢复。

源码：[展示及恢复判断](../../lib/factory/acceptance-view.ts)、[验收入口](../../components/workspace/factory-acceptance.tsx)、[验收内容](../../components/workspace/factory-acceptance-pane.tsx)。本轮没有新组件、轮询或内部错误前缀的新主文案。

## 4. 服务端恢复资格与事务边界

恢复服务面向明确的 host 未执行 Profile 拒绝；不能仅凭错误文字或 blocked 标签获得资格。

- task 与 attempt 必须均为 blocked，阶段为 review/verify，并保留当前 candidate；run 必须是该任务的独立 acceptance，带 host 写入的固定拒绝及对应结构化报告。
- startedAt、session、lease、stop request、retry/continuation 等执行或续接标记须为空；不存在 run chunk、checkpoint、artifact、capture 等执行证据。
- 校验只读角色、definition digest、执行身份、Profile、来源选择、request epoch 与原检查 assignment；存在活动 run 或未结束 question 时拒绝恢复。
- v2 其它已执行审阅仍消耗单次审阅预算；只有持久化 host 恢复回执能证明此前某次受阻检查未开始。
- Owner 仍调用既有 retry 入口。锁外仅刷新原冻结来源的既有额度，随后锁内再次核对权限、状态、revision、epoch、candidate、源 run 和绑定。
- 同一事务内完成 retry、新 attempt、排队和 bind，核对新检查保留原 Harness、模型、Profile、订阅/API 来源、候选与命令；只有 COMMIT 后才执行既有运行交接。失败整体回滚；重复 eventId 读取原回执。
- 当前实现只为 qualified blocked 提供 `checkStartRecovery`；failed 没有借此获得新恢复权限。

真正的 question 恢复仍需要原会话、提问记录与 continuation custody。新路径明确排除这些情况；历史 `factoryQuestionRunMismatch` 不会被当成用户已回答问题，也不改写旧 run 为成功。

源码：[资格与来源一致性](../../lib/factory/check-start-recovery.ts)、[事务及私有恢复权限](../../lib/factory/store.ts)、[正常派发](../../lib/factory/dispatch.ts)。

## 5. 已运行的目标验证

测试在授权 Docker Cloud Sandbox 内运行；以下数字保留各轮当时的范围。模拟数据、接口替身与数据库回归不等于真实模型成功。

| 轮次 | 实际结果 | 证明范围 |
| --- | --- | --- |
| 后端首轮 RED | 25 total / 22 pass / 3 fail | 两个叶子失败为 Profile 拒绝被误归 question mismatch，以及 Owner 恢复抛 factoryTransition；第三个失败仅父 suite，不算第三项缺陷 |
| UI 首轮可信 RED | 64 total / 59 pass / 5 fail / 0 skip | 可见性、列表行、producer 入口、错误 Spinner、当前原因详情五个目标断言失败；两个安全负例通过 |
| v2 UI RED | 88 total / 86 pass / 2 fail / 0 skip | 纯函数与真实 Pane 都暴露 flow v2 failed review 的无效 retry；此前目标和详情展开已通过 |
| 线程 action RED（旧 1cb） | 33 total / 27 pass / 6 fail | 新能力投影为 undefined 的目标断言失败，含正例保护；六个失败不等于六项产品缺陷 |
| 线程 UI 可信 RED v2（旧 1cb） | 11 total / 9 pass / 2 fail / 0 skip | ended independent check 误显示 Retry，以及 strict question recovery 的普通 Send 未禁用；其余既有、queued wake、producer/current question 正例通过 |

早先验证树为 commit `9ca8698e48a5ec43e0d2896d926a7fa1e36d4f85` / tree `e14f4a697605b987d499aaf44e0f68be25336ac5`。以下结果已经实际取得，**这些数量只属于 9ca/e14，不改记为后续 f200 或 1cb 的结果**：

| 验证范围 | 上一树的实际结果 |
| --- | --- |
| Checks DB | 179 / 179 通过 |
| Profile DB | 44 / 44 通过 |
| Factory 套件 | 459 total / 458 pass / 0 fail / 1 skip；跳过项不计作通过 |
| Factory acceptance UI／Workflow／Subscription／Mobile | 分别为 88／11／128／158 通过 |
| Typecheck、lint、i18n、polling、error-cause | 均通过 |
| Migration 检查 | 55 通过 |

早期 UI 夹具曾因 Happy DOM 失败格式化、翻译函数引用与缺少 RAF 异常；新线程 UI 首轮 11 fail 则为 mock 未保留 `pageRefreshSignal` 导出。后者只修测试以保留真实模块 exports 后，才取得上表 11/9/2 的行为 RED。导入/夹具故障均不算产品 RED。

回归覆盖资格伪造、执行／提问痕迹、绑定与 revision 不一致、重复提交、已知拒绝、未知结果和旧流程兼容。后续 `f20032caba34a28b8d6a9e18ed9c3f9e1b956617` 的 Docker source/UI、DB、build 均已取得 exit 0；`1cb98b2e372b1fba91c1d0aafa900d9ec4bfffb9` 的 Docker release-checks 与 production build 均为 exit 0。[CI 41983848093](https://github.com/alexj11324/Mikka/actions/runs/41983848093) 对应 1cb，四项 required 检查全部通过。上述成功未覆盖随后真实 UI 发现的线程通用 Retry 缺口，不代替生产恢复，也不把 9ca 的分项数量移植到新树。

bbf2 的 Docker checks 与 production build 均 exit 0：typecheck、lint、i18n、`test:issues`、`test:groups` 通过；action 33/33、Factory flags 23/23、UI 组合 17/17（含全部 11 个 Composer 用例）、Factory acceptance 88/88，四个目标用例均通过，所述本轮用例全部 0 skip。重叠套件分别记录，不相加制造总数。正常本地 `/api/version` 返回 HTTP 200，版本精确为 bbf2；不是生产部署验证。

最终 [CI 41988401387](https://github.com/alexj11324/Mikka/actions/runs/41988401387) 于 2026-11-05 07:44:07 UTC success：32 checks 中 27 success、5 个预期 skip，四项 required 全部成功；全部 10 个 workflow 为 success。[Desktop 41988401419](https://github.com/alexj11324/Mikka/actions/runs/41988401419) 实际完成 checks、icon 与 Electron smoke。CI 测试的是 merge `07f9c700bcfe214b84d90ebb0c41fbf2251bf782` / tree `adad0b8f5c7d429e9fe5f3f1330c49e4c8fa9ce3`，父提交为 main `f793f3d40b3ed167b26d8ab1d30c2bbdf4903418` 与 bbf2；预期 skip 不算通过用例，CI 合成 merge 也不冒充已合入 main。

## 6. API 余额路径的独立生产复查

在已发布的 main `122fd9054b5400569fd2518f55c52cec8f04d28a`，真实 API 余额错误现已显示现有 Change model 操作。点击能打开模型菜单，Escape 关闭并把焦点归还触发按钮；本次检查没有改变模型，也没有发送新请求。

DeepSeek 独立真实请求仍以 `Insufficient Balance`、0 retries 受阻。界面恢复入口通过不等于 API 调用成功；本记录不推断未观察到的 HTTP 402，也不把此错误解释为 Claude Profile 拒绝原因。详见[余额恢复记录](issue-1296-chat-balance.md)。

## 7. 当前批次、环境与待补验收

- 源 PR：[#1352](https://github.com/alexj11324/Mikka/pull/1352)，head `95abb5b2c5974ff769093fc5f9181fe0614bfd1b`。
- 本批先整合 main `81f8493c1a76f371f90008ddacc039abf185eaba` 的模型难度路由，再整合 `2400b95fa3faa05b50a2380e8c9298dd66ba0d4c` 的读取/live 改动。随后 main f793 的 12 个变更路径经只读交集复核，无 Web/Expo UI、Factory 恢复或 Profile gate 直接变更；CI 已覆盖 f793 与 bbf2 组合。保留 Docker bbf2 的真实 UI 版本，不重复构建或把截图重标为合成 merge；不据此宣称上线。
- 发布批次：[#1353](https://github.com/alexj11324/Mikka/pull/1353)，仍为 draft；当前 head `bbf2f70087c459fd82fbc7a38d47c0402f990df6`，tree `fc74bf906bf44f89635f2e52eff5e3c917117e0b`。截图所用旧 head 为 `1cb98b2e372b1fba91c1d0aafa900d9ec4bfffb9` / tree `475ab972e4ee158f89cbe0caa585267dff8585b2`；更早 f200 为 `f20032caba34a28b8d6a9e18ed9c3f9e1b956617` / tree `c819e97d06dbee8dac6be131a90a70cc90285d61`。
- 事务整合保留 COMMIT 前原冻结 Profile 再核验及事务登记；队列阶段曾准入不能代替提交时的权限与来源复核。
- 尚未上线的订阅 acquire-expiry 迁移仅从 `20261105035000_byos_acquire_expiry.sql` 重命名为 `20261105150000_byos_acquire_expiry.sql`，调整到已合入 routing schema 之后，并同步测试引用；Git 记录为 100% rename，SQL 内容未改变。上一树的 migration 结果不充当此次改名后的结果。
- 最终 QA 使用授权 Docker Large 内新的自有 PostgreSQL 17 cluster：loopback 端口 `55496`、全新 `mikka_e2e`、独立 descriptor 与 lease；1cb 的真实 Expo Web 已完成两张余额截图。没有修改旧测试基库，也没有用假 Gateway key 绕过运行资格。

截图使用正常 attestation、leased owner 与产品浏览器 handoff。余额为标记终态消息及静态错误 session 的合成 fixture，不发模型请求。blocked candidate 已成功 seed，同样不构造冻结 Profile/device 授权，仅证明候选可见、静态受阻及详情；不得将合成页面或无权限 retry 的负例记为真实恢复成功。

### 已保存并独立视觉复核的截图

五张 1cb 原图与一张 bbf2 AFTER 已原样复制至仓库证据目录；前五个图片 blob 已上传，尚无 evidence commit。链接文字保留原文件名，SHA-256 已逐一核对复制前后相同。

| 原始文件 | 场景 | SHA-256 |
| --- | --- | --- |
| [mikka-1296-expo-balance-375-1cb-1793862796141.jpg](issue-1296-evidence/recovery-1cb-expo-balance-375.jpg) | Expo Web，375 × 812，浅色 | `07886b3b72f43da3b361aa6b57f6bd7dbe3dcac62d1f6ccd280bc09cff87185c` |
| [mikka-1296-expo-balance-dark-430-1cb-1793862872240.jpg](issue-1296-evidence/recovery-1cb-expo-balance-dark-430.jpg) | Expo Web，430 × 932，深色 | `e4d1c6d167b63ca31a81f74d02b4e128ba50ac6352a9cefcca89150e168ee302` |
| [mikka-1296-next-balance-menu-1cb-1793863182861.jpg](issue-1296-evidence/recovery-1cb-next-balance-menu.jpg) | Docker Next production build，1363 × 936，英文模型菜单打开 | `d214f6117853b70c77e812609a60b2915a7a4d4b31042e3bb115466acd6ddc5f` |
| [mikka-1296-next-blocked-en-430-1cb-1793863295294.jpg](issue-1296-evidence/recovery-1cb-next-blocked-en-dark-430.jpg) | Docker Next production build，430 × 932，英文深色受阻面板及展开详情 | `beb3579796331e549de499e24d7c065129be0a745ee6b022dee42ba5637234b2` |
| [mikka-1296-thread-retry-red-1cb-1793863537168.jpg](issue-1296-evidence/recovery-1cb-thread-retry-before.jpg) | Docker Next production build，375 × 812，线程通用 Retry／Composer 修复前的真实 UI RED | `124452d3250b24b94e0e9cc091e40d44c6101db5f8493c63afa3a659addc5765` |
| [mikka-1296-thread-controls-zh-375-bbf2-1793864565793.jpg](issue-1296-evidence/recovery-bbf2-thread-controls-zh-375.jpg) | Docker Next production build，375 × 812，bbf2 中文线程控件 AFTER | `9c26da227033ab746d266ae1b6d61e143a44eaab245ad314ab0c12b93f6729e8` |

独立查看两张 Expo 图：气泡完整换行，未见横向溢出、控件重叠或底部输入裁切；430 图为实际深色背景。“API 余额不足”及“聊天模型”入口可见，没有 raw request ID 或误导的失败重试。截图仅证明静态视觉，不能据此宣称按钮已操作、AX/键盘通过、精确对比度达标或原生安全区实测；输入区显示的当前模型也不代表此 fixture 实际调用了该模型。

Next 第三图独立复核：`Insufficient API balance` 与 Change model 清楚可见，菜单完整显示当前勾选的 Mikka Default，未见布局重叠或底部裁切。另有正常浏览器交互实测：Expo“聊天模型”打开同域 Next 新页，Change model 打开该菜单，Escape 关闭并将焦点返回 Change model；没有改变模型、发送消息或调用模型。这是隔离 Docker 内真实页面操作，不冒充生产部署或真实 API 余额恢复。

Next 英文 430 深色受阻图独立复核：固定 candidate 的 SHA、仓库及环境完整，Review blocked 与 Review Blocked 状态清楚，诊断仅在展开的 Details 下出现，未见横向溢出或遮挡。真实浏览器已确认详情默认折叠、点击展开、中文 Details 可用 Enter 展开/收起且焦点保留，Independent review 能导航到对应合成 review run。DOM 读取确认该操作上的 `lucide-circle-dashed` 无 animation；这不是系统 Reduce Motion 测试。面板未提供未授权 retry；该 1cb 版本进入线程后仍有上表所列通用 Retry 缺陷。

第五张 1cb RED 图独立查看确认：Profile 准入拒绝行旁有“重试”，底部 Composer 显示“告诉 Claude Code 下一步做什么…”。这些是不应提供的通用操作入口；未点击 Retry、未发送或调用模型。bbf2 的行为 GREEN 和第六张 AFTER 图单独记录，不覆盖或重标此 before 证据。

bbf2 的 375 中文 AFTER 独立复核：Retry 已消失，Profile 拒绝长句完整换行，Composer 保留并显示“独立检查已结束，请在验收中处理结果。”，发送控件呈禁用状态，未见溢出或遮挡。真实浏览器填入“仅用于验证禁用发送，保留草稿。”并按 Enter 后，AX 仍保留原草稿且 Send disabled；只读 DB 前后均为 runs=2、messages=0、task revision=7，未增加运行或消息，随后正常清空草稿。英文 430 深色也已现场查看，文案完整两行、无 Retry、Send disabled、无重叠；该 AFTER 文件共享同步失败，不附链接、不重复捕获同一状态。

375 中文受阻面板曾实际检查无溢出，但该面板截图文件同步失败，本报告不附文件或链接；上表第五张为另一张已同步的线程 RED 图。五张图均保留 1cb 原版本，不冒充后续修复 head 的最终截图。

| 项目 | 当前记录 |
| --- | --- |
| 1cb 的 Docker 验证与 build | release-checks、production build 均 exit 0；分项日志/数量待按实际归档，不沿用旧树数量 |
| #1353 精确 head CI | bbf2 / run 41988401387 success；四项 required 成功，实际测试 f793＋bbf2 的 merge 07f9c700，完整身份见上文 |
| bbf2 Docker GREEN、production build 与最终截图 | checks/build exit 0、版本 HTTP 200 精确 bbf2；375 中文 AFTER 已独立复核，英文深色与非空草稿 Enter/DB 不变已实测；英文附件同步失败 |
| merge、生产 READY/version | 代码与本地 UI 验证完成、可合并；当前仍 draft，证据提交、实际 merge、部署与生产版本待补 |
| Next 中文 375：blocked 入口、静态状态、原原因详情 | 实际页面/键盘检查已完成；截图同步失败，不作为附件 |
| Next 英文 430 深色：候选与 Details | 已保存 1cb 实图并独立复核；面板局部检查通过 |
| Independent review 线程通用 Retry／Composer | bbf2 目标 GREEN、375 AFTER、非空草稿 Enter/DB 不变及 CI 已取得；旧 UI RED 操作未执行，生产复验待补 |
| Expo Web 375／430：余额提示与聊天模型入口 | 两张 1cb 图已保存并独立复核；正常打开 Next、菜单打开及 Escape/焦点返回已实测，不是原生 picker 证据 |
| ALEX-60 正常 Owner UI 同候选、同来源恢复及独立审阅结果 | 待补录 |

本轮尚未证明恢复后的 Claude review 成功，也未进行真机 VoiceOver、Dynamic Type、Reduce Motion 或原生键盘验收。生产复验继续使用原冻结的 Claude 订阅来源、`claude_code` Harness 和 `claude-haiku-5-5`；不因新路由功能换来源或模型，分别记录真实成功或阻塞。
