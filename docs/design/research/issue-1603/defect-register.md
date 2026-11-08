# Issue 1603 — 已复现问题与修复登记

## 最终状态（2026-11-08复核）

**19项确认缺陷全部已修复、合并并上线，#1603已于2026-11-07 17:11:55 UTC关闭为completed。** 最终merge为8fffe80c，主CI12/12成功，Web及其余主要发布链成功，公开生产版本曾独立核对为8fff＋官方ca99。[最终发布证据](b73-final-release.json)与[完整关闭判定](final-closeout.json)补齐了下方历史快照中的发布待办。

按已合并的[#1644](https://github.com/alexj11324/Mikka/pull/1644)，本任务的UI／交互／导航／刷新范围通过CI、本地正式构建真实交互与截图、生产READY和源码绑定完成验收；通用共享账号生产回放不再是该类任务门槛，未执行也不伪称通过。[A–D最终关闭评论](https://github.com/alexj11324/Mikka/issues/1603#issuecomment-6710483644)保留完整理由。各缺陷发生×影响分数仍是当时工程估计。

---

## 历史缺陷与回归快照

下文原有“当前”“待生产验收”等表述保留为各阶段事实；不把后来的完成状态倒填到旧观察时点。当前结论以上方最终状态为准。

**当前共登记 19 项确认缺陷，全部完成最小修复并已 merge。** 前 17 项分别随 #1619／#1626 合并；第 18／19 项随 [#1637](https://github.com/alexj11324/Mikka/pull/1637) 于 **12:48:11 UTC** merge 为 `8fffe80c9827913541a3a824b3813326dd1f2ae8`，parents 为 `b5271361bbef8a619e06d472a58a03925dc6489f`＋`b73e477934f9fa803ea971837e37c6011db15839`，实际 tree `fa0d02cab2a760544f4d7d2991f1be0f6585fd70` 与预测一致，见[最终合并回读](b73-final-merge-verification.json)。创建时 base 1ed、候选 tree 64f、[b527 增量审查](b73-main-b527-advance-audit.json)和 b73＋e290 的本地运行各自保留。**正式部署及指定 SMOKE 生产验收 PENDING**，详见[候选与合并状态](followup-1637-candidate.json)。

历史主批次候选源码：`156b6a2779d1ee71161b99ab47b3484e2a8b5704`。最终手动 UI 使用本地整合提交 `5a752a50eb74c22681cd7dd8511ff6d2e58fc46f`（main `ad5e5db5` + 候选 `156b6a27`），不是最终 GitHub merge；完整运行与截图状态见 [README.md](README.md)。 主批次 [#1619](https://github.com/alexj11324/Mikka/pull/1619) 已合并为 `efb95d951ddbeca1af04bc80d011ccbc2a9f0188`；第 17 项后续修复 [#1626](https://github.com/alexj11324/Mikka/pull/1626) 已合并为 `26ef4de15129e22503e152258ee9cb2e4aeae8bd`，源码树 `9cec7cc5dee0fe71eff576e3f84136ca51ed3def` 与已通过 CI 的 head `6ccb50d7` 一致。

## 验证状态与版本边界

精确 `156b` 与官方 overlay `2cbb930e409ccc247f7692abc9e2dd1152a571fe` 的[完整类型检查与生产构建](156b-build-evidence.json)均 exit 0；[本地真实 API 重跑](156b-api-evidence.json)完成 35 次读取、结果 pass，fixture 与租约干净释放。2026-11-07 07:01:03.187 UTC 的[最终 CI 审核](156b-ci-review.json)确认，关联该 head 的 30 项检查为 **23 success、7 skipped**；[主 CI](https://github.com/alexj11324/Mikka/actions/runs/42347352032)、[API/CLI CI](https://github.com/alexj11324/Mikka/actions/runs/42347352010)和[Desktop CI](https://github.com/alexj11324/Mikka/actions/runs/42347352004)均 success，真实 Apple Silicon packaged acceptance 及证据审计已完成。CI 检出的合成合并 SHA、后续 main 变化与占位检查限制详见 [README 的最终验证状态](README.md#最终候选当前验证状态)。

本地整合 `5a752a50` 的源码树为 `977111e65ae6bc8c15b88e01810f2f143512c4dd`，使用官方 overlay `ac5980696802f188a81124a8a3f2513be2d14e9e`；[生产构建](integration-build-evidence.json)exit 0，用时 128.36 秒，renderer 为 `074aadefa5f4b52e647c5e12ffe816c6b1d5cd3873c7481826295b8b529118fb`。[实际运行绑定](integration-runtime-binding.json)于 07:19:14.159 UTC 确认 source／compiled／served build 一致。最终图库命名为 `integrated/`。

**历史手动 UI（本地整合 `5a752a50`／overlay `ac598069`）已完成所列路径的复验与实际清理；第 17 项 switcher 误分类已在 #1626 修复并合并。新增第 18／19 项的本地红绿绑定 f722 加各自补丁，不能代替组合 b73e477 的 CI、新 UI、merge／最终部署及生产验收。** [整合观测](integration-observations.json)保留 296 条原始记录中的 200 条脱敏选摘、23 张图及 #296 close（fixtureCleanup=true、lease=released、审计 passed）。人工会话实际提交 2 次评论和 1 次回复；合成 stored activity／后台消息不执行 live model 或工具，不能把 API 入口的 no-business-writes 结论套用到 UI。

表内基线证据属于 `f3ef8f4a`，中间 UI 属于 `9005d8ea`，候选 `156b` 与最终本地整合证据分别保留。`9005` 人工租约为 quarantined，owned 数据库已退役，`cleanRelease=false`，见[退役记录](9005-runtime-retirement.json)。

实际 PG 断线窗口中服务器 `/api/workspace/switcher` 返回 403；既有 catch-all 将未知异常误归授权拒绝，继而触发既有安全缓存失效路径。此历史实现随后在 #1626 被最小修复：无会话 401、真实 `WorkspaceError` 403、其余未知错误 500／`workspaceReadFailed`，保留 `private, no-store` 与客户端拒绝策略。该补丁有独立路由与 CI 证据，**不将旧 `5a752a50` 手动运行改标为修复后的新 UI 运行**。最后旧 DOM 同节点与首次断开之间没有连续采样，不能把重建精确归因于点击 Retry，也不能泛化为普通 500 必然清缓存。源码链和限定见 [README](README.md#本地整合会话的连续性与连接恢复边界)。

历史 5a 的部分 Artifact／全宽错误图显示折叠 toast 栈及输入角落重叠；[真实 Sonner 源码复核](toast-source-review.json)解释其默认行为。本轮 b73 已实际 hover 前排 toast，并在 Artifact modal 中 Alt+T／Tab 到经确认的 BUTTON Retry，完成真实失败重试及清故障后的成功恢复；同一文档／输入／scroll、选区和焦点恢复有[新 UI 证据](b73-ui-summary.json)。**默认折叠栈仍可能拦截后排指针，不能称全部错误画面无遮挡或永久死锁。** Library 清故障后为既有自动恢复；LI 误按图排除，不作产品失败或通过。旧窄屏图仅证明该旧版本的当次观察，未补成 b73／iOS 验收。

## 已确认缺陷、最小修复与发生概率 × 影响

以下发生概率与影响均为 **1–10 的工程估计**，依据具体触发条件，不是线上发生频率或统计概率；README 的摘要采用本表同一组估计。隐私、授权和输入损失按严重性处理，不用乘积阈值延后修复。表中的“组件”指真实 React / SWR 生命周期或源代码单元回归；不等于真实浏览器。

| 项目 | 具体触发与根因 | 最小修复 / 当前状态 | 证据层级 | 发生 × 影响 |
| --- | --- | --- | --- | --- |
| 设置导航丢 workspace | 显式 `workspace=W` 进入 Settings / 子页 / 返回时被丢掉，同一工作区导航误触安全作用域变化 | `lib/settings-navigation.ts` 保留地址中的显式 workspace；目的地址明确指定的值优先，默认作用域仍保持隐式 | 导航回归；9005 UI 及整合 #18–36 确认 W 保留 | **7 × 6 = 42** |
| Settings 全局重建 | routed / legacy Settings 的顶层组件分支不同，冷 dynamic fallback 替换整个窗口 | `issue-workspace.tsx` 与 `settings-shell.tsx` 共用稳定外壳，抽出路由内容；fallback 限定在内容区 | 基线真实截图 + DOM 断开；组件 red→green；整合 #15–21 冷加载各 1 个且原节点保持 | **8 × 5 = 40** |
| Settings 键盘搜索不一致 | 顶栏公开 Cmd/Ctrl+K，但 Settings shortcut 未走离开设置并打开搜索的入口 | 键盘和顶栏共用 `searchFromBar`，保留 IME / dialog / busy guard，设置内裸 C 不创建任务 | 组件 red→green；整合 #22–25 实际 Ctrl+K 搜索弹层 | **4 × 4 = 16** |
| Back/Forward 错会话 | Ada→Settings→搜索→Back/Back→Forward/Back；router 先 render，空操作 `tidyAddress` 提前更新 `seenQuery`，popstate 跳过 Ada 同步 | `workspace-navigation.write` 只在真正写 history 时更新 seenQuery；不删除 queryMoved 或 dirty guard | 9005 真实失败；组件两种事件顺序 red→green；整合 #27–36 完整序列地址／Ada 内容／草稿／scrollTop340 一致 | **5 × 5 = 25** |
| 过期 action 静默硬刷新 | 旧页面收到 removed-action header，自动 reload 丢未提交输入；过早发出的刷新需求还可能错过订阅 | `lib/app-build.ts` 终止旧业务请求流并显式提示；`VersionGuard` 先订阅再读取已有 marker；不自动重载或重放 mutation | build / network 与晚挂载 UI 回归；整合 #256–269：提示前 document=1／shell不变，显式 Refresh 后=2／草稿恢复／群聊POST不重放 | **3 × 8 = 24** |
| 后台聊天补读拉到底部 | 历史最大 person message position 增长被当作本地发送；另一标签或补读打断历史阅读 | `coordinator-chat.tsx` 仅对当前 composer 被接受的本地发送递增滚动信号 | 组件 red→green；整合 #65–73 两条后台消息到达，草稿／焦点／选区及 scrollTop340 保留 | **7 × 4 = 28** |
| 任务编辑器后台失败 | 已授权 TaskForm 因普通读取失败被整个卸载，丢失未保存输入；拒绝后的 dirty guard 还可能阻止离开 | `task-detail.tsx` 对普通失败保留原编辑器；明确拒绝关闭编辑器并释放 dirty/flush；沿用局部 Retry | 真实 SWR / Y.Doc 组件 red→green；整合 #119–124 的 8 次 pollIssue503 保留 comment/title 与焦点选区 | **4 × 8 = 32** |
| 群聊在途 / 失败消息离页丢失 | pending 使用组件本地 useState，设置往返后丢失发送状态或失败待重试文本 | `group-chat-view.tsx` 使用已有 scoped view state，等待同一 promise；只显式 Retry，确认读到 sentId 后清理 | 导航 / late promise / scope 组件 red→green；整合 #212–250 在途离开返回保留失败消息、POST仅1次，普通503保留草稿/焦点/scroll240 | **5 × 8 = 40** |
| Artifact 已读内容被后台错误替换 | Library error 分支清掉已读列表；Viewer detail/text error 卸载文档或 iframe；正文 Retry 只重读 detail | 普通失败保留同一列表 / 文档 / iframe；流外 toast；Viewer Retry 同时重读 detail 和当前正文版本 key | 基线三态与真实 SWR red→green；整合 #167–206 列表/文档/iframe同节点，正文选区/scroll650保留；该次默认toast栈交互未完成；b73的Library／文档键盘复验另列 | **4 × 5 = 20** |
| 线程读失败中断 / 首载无恢复 | lookup 初载失败一直 skeleton；背景 lookup / detail error 卸载已打开线程与输入 | `thread-column.tsx` / `issue-thread-panel.tsx` 保留已授权内容，首次失败局部 Retry | 组件 red→green；整合 #133–140 的受控503与窄屏 input/list/shell同节点；服务端误报403的另一条路径已在后续#1626修复 | **4 × 5 = 20** |
| 撤权后旧内容复活 | 保留旧数据若仅看普通 error，会在拒绝之后的网络失败恢复旧历史；线程缓存的 Changes / Acceptance 及 header 也可能继续露出 | 复用 `readAccessFailure` 与明确拒绝码；锁存拒绝直到成功读清 error；所有已缓存内容分支同样关闭 | 授权边界组件回归；整合 #236–245 实际403→503，历史0、输入禁用、不恢复旧内容 | **3 × 9 = 27** |
| 拒绝后 Retry 跨 remount 卡死 | SWR 同 key 去重只通知旧 mount 的 onSuccess，新页面无法解除拒绝状态 | Library / Group / 线程观察 SWR 的实际成功与 error 清除；后续普通 error 不能解除拒绝 | 两项真实 SWR red→green；整合 #246–250 成功授权Retry才恢复历史/输入与失败pending | **4 × 5 = 20** |
| Board 过滤名称跨账户 / 工作区 | 共享 localStorage 的 project / label 名称在新 scope 被 chip 原值 fallback 展示，且可能筛空任务 | `board-page.tsx` 把过滤值放入现有 owner/workspace view store；旧无归属 filters 一次性重置，布局偏好保留 | 4项真实render red→green；整合 #274–287 实际两工作区切换隔离Medium/APP-1/旧draft，返回恢复Medium/List/评论 | **5 × 8 = 40** |
| 注销后旧 promise 回填私有状态 | 旧 store setter 在 provider 退出后仍可写；真实清理 helper 漏删 view 键，仅补删键仍被未卸载 setter 回填 | `view-state.tsx` activate/retire；`clearChatDrafts` 同步 retire 当前写入者，再清 draft/view session 键；新登录 provider 正常可写 | provider retirement/helper red→green；整合 #289–295 真实Sign out到登录页，view keys68→0；旧callback另有组件证据 | **5 × 8 = 40** |
| 减少动态效果未覆盖 CSS | JS MotionConfig 不控制 Dialog / AlertDialog 缩放与 Skeleton pulse | 沿用 `motion-reduce`：缩放变为 1，Skeleton animation none；弹层淡入淡出保留 | 编译CSS；整合 #14/20/24 skeleton animation=none、dialog scale/transform=none；非iOS系统验收 | **4 × 4 = 16** |
| 任务评论离页丢失 | 9005 `#issue-comment` 输入→Close→Board→重开，草稿丢失；`issue-activity.tsx` 组件本地 useState | `IssueActivity` 的 comment / reply / reply target 使用既有 scoped store，稳定 task id 经 TaskDetail→IssueEditor 传入；未授权 cached preview 不恢复 Activity 草稿；提交清理语义不变 | 9005真实失败；目标4 red→green、完整DOM28/28；整合 #87–114 评论/回复/目标关闭重开恢复，3次真实提交各自清理 | **5 × 7 = 35** |


## 最终运行新增、已在后续 PR 合并修复的第 17 项

| 项目 | 触发与根因 | 最小修复 | 当前证据／状态 | 发生 × 影响 |
| --- | --- | --- | --- | --- |
| workspace 普通服务端失败被误报撤权 | switcher route catch-all 把 session／workspace 读取中的任意异常返回403；DB断线可被误归workspace拒绝，客户端按既有安全规则退役缓存子树 | 只收窄服务端分类：无会话401、真实WorkspaceError403、DB／未知异常500／workspaceReadFailed；private,no-store与仅错误类日志。既有settings backend入口回归，客户端真实403拒绝策略保持 | 07:31:12.114 的历史switcher403与PG断线同期，具体throw／remount时刻仍未知。本地34项：32pass/2fail→34/34pass；4项requiredCI全部成功。**FIXED AND MERGED：#1626，26ef4de1**；该 SHA 历史部署已核实，未补跑新本地 UI，最终指定账号生产验收仍待完成 | **4 × 7 = 28** |

上表为新增工程估计，不改变前面 16 项的原风险分值。[后续修复证据](switcher-followup-evidence.json)记录两文件 blob 与实际主批次基底的一致性、本地 red→green、完整类型检查、lint 与独立审查；[CI 审核](switcher-ci-review.json)记录 17 项检查为 16 success／1 skipped，4 项 required 全部 success。Browser gate 仍是既有占位检查，名为 Production build and browser interactions 的 required check 是数据库分片汇总，不能据名称宣称新人工 UI 验收。

[主批次合并回读](batch-merge-verification.json)、[合并前最新主干复核](final-main-93724.json)与[后续合并回读](followup-merge-verification.json)分别保留实际 parent／tree／SHA；#1626 的 merge 树与已测候选树一致。[最终运行回收](integration-runtime-cleanup.json)确认业务 fixture 清理、租约释放、应用连接归零和临时计算停止；保留的托管测试身份／失效 session 不算业务 fixture 泄漏。

Toast 默认折叠栈本身不登记为确认缺陷。b73 实际 hover、modal Alt+T／Tab／BUTTON Enter 和输入恢复已补充交互证据，见[新 UI 摘要](b73-ui-summary.json)；几何重叠、一次被拦截的 Library 拟点击和 LI 误按保留为限制。早期[静态报告](toast-source-review.json)保持原快照；本轮第 18 项修复与真实交互证据分别记录，merge 已完成；正式部署／指定生产验收仍 **PENDING**。

## 第 18 项：持续失败 Retry 关闭就地恢复入口（已修复并完成定向 UI，#1637 已 merge）

| 项目 | 触发与根因 | 最小修复 | 当前证据／状态 | 发生 × 影响 |
| --- | --- | --- | --- | --- |
| 持续失败 Retry 删除错误通知和即时恢复按钮 | 已读内容发生背景错误后，点击真实 Sonner action；Sonner 1.7.4 在回调后自动删除通知，而再次失败没有改变 effect 的失败条件，因此不重建通知 | 7 个既有读取／连接错误 action 同步 `event.preventDefault()`，再调用原 mutate／retry；成功或卸载时仍由原 effect dismiss | f722 加补丁的真实 React／SWR／Sonner 8 条路径 **8 red → 8 green**。包含 ArtifactLibrary、Viewer detail／当前版本正文、IssueThreadPanel、ThreadColumn、TaskDetail、GroupChatView 和真实 App 的 ConnectionStatus。**FIXED AND MERGED：#1637／8fffe80c；b73 精确 CI 与本次所列定向 UI 完成，正式部署／指定生产验收 PENDING** | **4 × 5 = 20** |

最初在 `26ef4de1` 的真实 ArtifactLibrary、React、SWR 2.5.1、Sonner 1.7.4 上动态复现并隔离重复：读次数 2→3、同一列表行保留、SWR 仍有 error，但 toast=false、Retry=false、inlineAlert=0、其他局部 Retry=0，unexpectedNetwork=0。随后 fetch main 到 `f7225f3e`，确认 7 个目标产品文件未变、重新得到精确红灯，再覆盖全部 8 条路径。用户失去可见错误反馈和即时重试，但旧内容保留，自动恢复／后续导航仍可能工作，因此不称永久死锁、数据丢失或权限绕过。

[冻结补丁与检查记录](toast-fix-evidence.json)保留真实回归及版本：`test:artifacts` **48/48**（包含新增 8 项）、`test:groups` **90 pass／1 既有数据库集成 skip**、`test:issue-readonly-dom` **28/28**，完整 root／API／frontend typecheck、定向 lint、UI／error／polling policy 和独立 review 通过。最终 harness 调整复用现有 Textarea、使用 renderer runtime URL import 后，相关完整入口再次通过；不把早先红灯日志伪称为最终 harness 文件哈希完全相同。无布局、缓存、授权分类、轮询、依赖或 schema 变化。Node／Happy DOM 的真实按钮行为不证明浏览器 hit-test、hover 展开、模态键盘或原生移动行为。

**CI 暴露的既有测试遗漏另行补正。** 首个组合 head `6b4a3eb` 的 `pnpm test:issues` 在 `scripts/thread-open-without-task.test.tsx:103` 仍零参调用 toast action，触发 `preventDefault` 读取 undefined；required `UI policy (strict)` 汇总因此失败，见[旧 CI 精确归因](final-ui-ci-6b4-failure.json)。这是本轮测试适配遗漏，未作为第 20 项产品缺陷。新 head `b73e477` 只将该文件两处 callback 类型改为带 Event，并传入一次真实可取消 Event，不修改产品回调。局部红灯 **12 pass／1 fail（13 项）** 后，完整既有 `pnpm test:issues` **404/404（11 blocks，0 skip／fail）**、oxlint／diff check 通过，见[补正记录](event-fixture-review.json)。这些本地结果不等于 b73 的 CI；旧 CI 后续 skipped 不算通过，也不在该简版推定 ARM64 的最终验收结果。

**b73 真实浏览器复验。** Library #66 的真实指针 Retry 在持续 503 下保留列表及局部按钮；#74 再点击发生在清故障前，之后由既有自动读取恢复，不能称 post-clear 拟点击成功。Viewer #111 确认焦点为 BUTTON Retry、#113 Enter；#112→115 metadata fault hits12→14、text6→8，按钮仍在。#117／118 清故障，#119 再确认 BUTTON Retry 后 #120 Enter，#121 Retry hidden，#122 的文档／scroll／input、列表及三外壳节点均同一且连接；scroll650、原草稿、selection5–15保留，焦点回输入。有效图为 [真实失败重试](b73/viewer-real-keyboard-retry-stays-after-failure.png)与[真实键盘恢复](b73/viewer-recovered-after-keyboard-retry.png)。更早 LI 上 Enter 的图排除；最终 fault hits library14／meta22／text12 含自动重试，不作单次点击读次数保证。过早的 resource timing 不证明最新 200。详见[摘要](b73-ui-summary.json)及[原序号选摘](b73-ui-operations.json)。

## 第 19 项：hosted Settings 往返丢批注与电脑线程 registry（已修复并完成定向 UI，#1637 已 merge）

| 项目 | 触发与根因 | 最小修复 | 当前证据／状态 | 发生 × 影响 |
| --- | --- | --- | --- | --- |
| hosted Settings 丢未发送批注和电脑线程 registry | `OWN_SETTINGS_FRAME=true` 的提前 return 排除 BrowserNotesProvider／ComputerAgentsProvider；普通 Settings 往返重建它们的内存状态 | 只把两个既有 providers 提到两种视觉 frame 的共同父层，仍处于原 SignOutBoundary 与认证／workspace scope 之内；保留 hosted 独立外观、props 及默认 AppFrame | 真实 IssueWorkspace＋真实 providers 精确 red 显示文字草稿保留、批注 `[]`、registry `null`；修复后 Settings **10/10**、既有 view-state 命令 **30/30**（包含这 10 项）。**FIXED AND MERGED：#1637／8fffe80c；b73 精确 CI 与本次所列定向 UI 完成，正式部署／指定生产验收 PENDING** | **4 × 7 = 28** |

该问题由最新 hosted Settings 设计分支引入，不能把旧 5a overlay 的稳定 AppFrame 证明套到新设计。独立 Settings 外观是明确设计要求；被丢弃的 provider 状态不是该外观要求的一部分。用例在导航前卸载注册卡，确保返回后不会自动重建 registry 而掩盖故障；green 确认 Settings 内批注及 registry 保留、hasComposer=false，返回后 hasComposer=true、文字草稿及原批注恢复、下一批注编号连续。

[provider 审查记录](hosted-provider-review.json)记录 root `tsrs --noEmit`、两文件 lint、diff check 与独立只读 review 均通过。此处没有把 root 类型检查扩大称为完整 desktop/API 构建。账号／工作区批注清除有独立断言；registry 的 owner 清除直接验证，随后 workspace 断言从已空 registry 开始，这一覆盖边界如实保留，实际隔离沿用未改的父层 key。数据叶子和 hosted frame 为 fixture，实际 providers 与 IssueWorkspace 是产品代码；没有浏览器、DB、模型或生产业务写入。最终工程估计采用 **4 × 7 = 28**，因被丢失批注是未提交输入；源报告早期影响估计 5 保留为估计修订记录，不修改实际红绿观察。

**b73 真实 BrowserNotes UI 复验。** 实际 BrowserPane 打开本地 version 页并用 picker 加 note1；hosted Settings 冷 chunk 延迟8000ms、命中1次，Back to app 后批注／文字草稿保留；再次真实 picker 加 note2，Remove note1／2编号连续。随后实际 Settings Back→Forward→Back 以及 Artifact 返回 Home 仍保留两条批注／文字草稿，普通 main documentRequests=1。切预留 alternate 工作区后 notes=0／Coordinator输入空，返回原工作区 notes仍0但原 scoped文字草稿恢复；显式两次scope导航后计数=5。真实Sign out到登录页，view keys16→0、含draft名称的键2→0，旧文字／批注不可见。此 UI 验证真实 BrowserNotes；电脑 registry 继续使用真实 provider 组件回归，不宣称运行模型或电脑会话。[14张新图库](b73-ui-gallery.json)与旧5a图库分开，所有输入为受管合成 fixture。

## 第 18／19 项组合版本及剩余门禁

单项补丁基于 `f7225f3eb1e38762dfdecde0395792c85b81ec22`。main 后续前移到 `1edbeca687119eb0ef71f209ac3d411fbc85b888`，15 个提交、49 文件；[增量审查](main-1ed-review.json)确认与组合补丁唯一共同路径是 `package.json`，分别改不同测试脚本，既有补丁文件 blob 与锁文件未变。#1637 最初 16 文件候选为 `6b4a3eb599179b3032e1717fc047d25284c25a9b`，tree `d45d992a4103ce3b144eae1575204e250a94e812`；CI 的测试事件遗漏补正后，最终已合并 head 为 `b73e477934f9fa803ea971837e37c6011db15839`，parent 为 6b，tree 为 `64f017ef52b2b7e42055ac305158ae71b4c87a7d`，相对 base 共 17 文件。

**当前 b73 已完成：** [精确 CI](b73-ci-audit.json)8 workflows success、31 checks为24success／7合法skip、4required全部success，真实Apple Silicon packaged acceptance成功；[新生产模式构建／运行绑定](final5-b73-build-receipt.json)含类型检查exit0；[独立API验收](b73-api-evidence.json)35reads pass并干净释放；[定向UI](b73-ui-summary.json)149条原始记录、14张入选图，manual close／fixtureCleanup／lease release／17文件audit完成。f722的单项结果、旧6b失败、5a／ac598图片及26ef历史部署各自保留，不互相改标。[最终资源回收](final5-runtime-cleanup.json)已独立确认：Medium stopped于12:36:29.554，broker于12:37:26关闭且精确进程0；两租约released，created0／cleaned76／retained7（4受管身份＋3失效session，active0）。broker主动SIGINT真实exit1，不声称所有进程exit0；实际merge／tree回读已完成，正式部署及指定SMOKE账号生产验收仍 **PENDING**。

先前 main 从创建时 `1edbeca6` 前移到 `dab5439b315a9b236697ba7b89f5578c3d6b8e6c`（#1639）的 4 个外部 PostHog 文档／ops／SQL／测试文件已有[独立审查](b73-main-advance-audit.json)。`f8c9e68e805c2b0bdd917cde78940063cf56cfa4` 仅为 main 保持 dab 时的历史预测树；main 随后又前移至 `b527…`，[最新增量审查](b73-main-b527-advance-audit.json)已完成，预期联合树为 fa0d02cab2a760544f4d7d2991f1be0f6585fd70，随后[实际 merge 回读](b73-final-merge-verification.json)已确认 8fffe80c 的 parents b527＋b73／tree fa0 均一致。应用证据仍是 b73＋e290，不能改称已经在最终 main 或实际 merge 上重跑。

官方 overlay 后续前移到 `ca99cf4719a890c214d187c146c07406ffebfba2`，与本轮 e290 相比仅 release workflow／README 两文件变化，应用源码／运行 assets／依赖锁／slot 导出无变化，见[overlay 增量审查](b73-overlay-advance-audit.json)。本地 b73＋e290 结果保持原标签；最终生产绑定另验。

**合并时的门禁计数与旧 CI 分开记录。** [b73 CI 审计](b73-ci-audit.json)在 12:27:27 UTC 为 31 checks＝24 success＋7 合法 skip、8 workflows success。Ready 后 [12:48:09.689 最终 guard](b73-final-merge-verification.json)为 32 checks＝25 success＋7 skip，4 required 全部 success；新增 Browser check `128407529192` 成功但仍为占位门禁，不冒充实际浏览器测试。12:48:11 merge／12:48:21.321 回读确认实际 parent／tree，至此 19 项修复全部已合并；新的 merged-head CI／正式部署及指定 SMOKE 验收仍单列待完成。UI raw／summary／gallery 保留合并前观察快照，不在本次改写。
