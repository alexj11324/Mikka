# Issue 1603 — 已复现问题与修复登记

候选源码：`156b6a2779d1ee71161b99ab47b3484e2a8b5704`。最终手动 UI 使用本地整合提交 `5a752a50eb74c22681cd7dd8511ff6d2e58fc46f`（main `ad5e5db5` + 候选 `156b6a27`），不是最终 GitHub merge；完整运行与截图状态见 [README.md](README.md)。 主批次 [#1619](https://github.com/alexj11324/Mikka/pull/1619) 已合并为 `efb95d951ddbeca1af04bc80d011ccbc2a9f0188`；第 17 项后续修复 [#1626](https://github.com/alexj11324/Mikka/pull/1626) 已合并为 `26ef4de15129e22503e152258ee9cb2e4aeae8bd`，源码树 `9cec7cc5dee0fe71eff576e3f84136ca51ed3def` 与已通过 CI 的 head `6ccb50d7` 一致。

## 验证状态与版本边界

精确 `156b` 与官方 overlay `2cbb930e409ccc247f7692abc9e2dd1152a571fe` 的[完整类型检查与生产构建](156b-build-evidence.json)均 exit 0；[本地真实 API 重跑](156b-api-evidence.json)完成 35 次读取、结果 pass，fixture 与租约干净释放。2026-11-07 07:01:03.187 UTC 的[最终 CI 审核](156b-ci-review.json)确认，关联该 head 的 30 项检查为 **23 success、7 skipped**；[主 CI](https://github.com/alexj11324/Mikka/actions/runs/42347352032)、[API/CLI CI](https://github.com/alexj11324/Mikka/actions/runs/42347352010)和[Desktop CI](https://github.com/alexj11324/Mikka/actions/runs/42347352004)均 success，真实 Apple Silicon packaged acceptance 及证据审计已完成。CI 检出的合成合并 SHA、后续 main 变化与占位检查限制详见 [README 的最终验证状态](README.md#最终候选当前验证状态)。

本地整合 `5a752a50` 的源码树为 `977111e65ae6bc8c15b88e01810f2f143512c4dd`，使用官方 overlay `ac5980696802f188a81124a8a3f2513be2d14e9e`；[生产构建](integration-build-evidence.json)exit 0，用时 128.36 秒，renderer 为 `074aadefa5f4b52e647c5e12ffe816c6b1d5cd3873c7481826295b8b529118fb`。[实际运行绑定](integration-runtime-binding.json)于 07:19:14.159 UTC 确认 source／compiled／served build 一致。最终图库命名为 `integrated/`。

**最终手动 UI（本地整合 `5a752a50`／overlay `ac598069`）已完成所列路径的复验与实际清理；第 17 项 switcher 误分类已在 #1626 修复并合并，最终部署及指定 SMOKE 账号生产验收 PENDING。** [整合观测](integration-observations.json)保留 296 条原始记录中的 200 条脱敏选摘、23 张图及 #296 close（fixtureCleanup=true、lease=released、审计 passed）。人工会话实际提交 2 次评论和 1 次回复；合成 stored activity／后台消息不执行 live model 或工具，不能把 API 入口的 no-business-writes 结论套用到 UI。

表内基线证据属于 `f3ef8f4a`，中间 UI 属于 `9005d8ea`，候选 `156b` 与最终本地整合证据分别保留。`9005` 人工租约为 quarantined，owned 数据库已退役，`cleanRelease=false`，见[退役记录](9005-runtime-retirement.json)。

实际 PG 断线窗口中服务器 `/api/workspace/switcher` 返回 403；既有 catch-all 将未知异常误归授权拒绝，继而触发既有安全缓存失效路径。此历史实现随后在 #1626 被最小修复：无会话 401、真实 `WorkspaceError` 403、其余未知错误 500／`workspaceReadFailed`，保留 `private, no-store` 与客户端拒绝策略。该补丁有独立路由与 CI 证据，**不将旧 `5a752a50` 手动运行改标为修复后的新 UI 运行**。最后旧 DOM 同节点与首次断开之间没有连续采样，不能把重建精确归因于点击 Retry，也不能泛化为普通 500 必然清缓存。源码链和限定见 [README](README.md#本地整合会话的连续性与连接恢复边界)。

部分 Artifact／全宽错误图显示折叠 toast 栈及输入角落重叠；[真实 Sonner 源码复核](toast-source-review.json)确认这是默认栈行为，hover／Alt+T 可以展开，同 ID 更新不抢占栈序。实际模态键盘、指针与 composer 可达性仍待验收；**不能仅凭截图判为永久遮挡／死锁，也不能标为全部错误 UX 已通过**。最终窄屏线程图无遮挡只证明那一项观察。持续失败 Retry 后通知存续是另一个待动态核实分支，未据静态截图登记为新的确认缺陷。

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
| Artifact 已读内容被后台错误替换 | Library error 分支清掉已读列表；Viewer detail/text error 卸载文档或 iframe；正文 Retry 只重读 detail | 普通失败保留同一列表 / 文档 / iframe；流外 toast；Viewer Retry 同时重读 detail 和当前正文版本 key | 基线三态与真实 SWR red→green；整合 #167–206 列表/文档/iframe同节点，正文选区/scroll650保留；默认toast栈交互证据尚未完成 | **4 × 5 = 20** |
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
| workspace 普通服务端失败被误报撤权 | switcher route catch-all 把 session／workspace 读取中的任意异常返回403；DB断线可被误归workspace拒绝，客户端按既有安全规则退役缓存子树 | 只收窄服务端分类：无会话401、真实WorkspaceError403、DB／未知异常500／workspaceReadFailed；private,no-store与仅错误类日志。既有settings backend入口回归，客户端真实403拒绝策略保持 | 07:31:12.114 的历史switcher403与PG断线同期，具体throw／remount时刻仍未知。本地34项：32pass/2fail→34/34pass；4项requiredCI全部成功。**FIXED AND MERGED：#1626，26ef4de1**；修复后无新本地UI运行，生产仍待验收 | **4 × 7 = 28** |

上表为新增工程估计，不改变前面 16 项的原风险分值。[后续修复证据](switcher-followup-evidence.json)记录两文件 blob 与实际主批次基底的一致性、本地 red→green、完整类型检查、lint 与独立审查；[CI 审核](switcher-ci-review.json)记录 17 项检查为 16 success／1 skipped，4 项 required 全部 success。Browser gate 仍是既有占位检查，名为 Production build and browser interactions 的 required check 是数据库分片汇总，不能据名称宣称新人工 UI 验收。

[主批次合并回读](batch-merge-verification.json)、[合并前最新主干复核](final-main-93724.json)与[后续合并回读](followup-merge-verification.json)分别保留实际 parent／tree／SHA；#1626 的 merge 树与已测候选树一致。[最终运行回收](integration-runtime-cleanup.json)确认业务 fixture 清理、租约释放、应用连接归零和临时计算停止；保留的托管测试身份／失效 session 不算业务 fixture 泄漏。

Toast 默认折叠栈本身不登记为确认缺陷；hover／Alt+T／Artifact 模态键盘及 composer 可达性属于未完成的交互证据，见 [toast-source-review.json](toast-source-review.json)。持续失败 Retry 的通知存续另待低成本动态核实。最终部署与指定 SMOKE 账号生产验收仍为 **PENDING**。

## 第18项：持续失败 Retry 关闭唯一就地恢复入口（动态确认，修复中）

在 `26ef4de1` 的真实 ArtifactLibrary、React、SWR 2.5.1、Sonner 1.7.4 上，第一次运行2项为1 pass/1 fail；独立运行持续失败用例再次失败。读次数2→3、同一列表行保留、SWR仍有error，但toast=false、Retry=false、inlineAlert=0、其它本地Retry=0，unexpectedNetwork=0。只有服务端读action使用内存fixture。

Sonner action默认在回调后删除通知；现有回调没有preventDefault，而失败布尔值未改变，通知effect不重建。用户失去明确错误反馈和即时重试入口，自动重试/后续导航仍可能恢复，因此不称永久死锁。发生 **4×影响5=20**。在最新main上做最小修复并验证成功时既有dismiss；Viewer/线程/连接提示的同形路径分别验证，不把静态猜测算动态通过。详见 [完整复核与red证据](toast-source-review.json)。
