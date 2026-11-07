# Issue 1603 — 已复现问题与修复登记

最终候选源码：`156b6a2779d1ee71161b99ab47b3484e2a8b5704`；完整运行与截图状态见 [README.md](README.md)。

## 已确认缺陷、最小修复与发生概率 × 影响

以下发生概率与影响均为 **1–10 的工程估计**，依据具体触发条件，不是线上发生频率或统计概率。隐私、授权和输入损失按严重性处理，不用乘积阈值延后修复。表中的“组件”指真实 React / SWR 生命周期或源代码单元回归；不等于真实浏览器。

| 项目 | 具体触发与根因 | 最小修复 / 当前状态 | 证据层级 | 发生 × 影响 |
| --- | --- | --- | --- | --- |
| 设置导航丢 workspace | 显式 `workspace=W` 进入 Settings / 子页 / 返回时被丢掉，同一工作区导航误触安全作用域变化 | `lib/settings-navigation.ts` 保留地址中的显式 workspace；目的地址明确指定的值优先，默认作用域仍保持隐式 | 导航回归；9005 UI 确认 W 保留 | **7 × 6 = 42** |
| Settings 全局重建 | routed / legacy Settings 的顶层组件分支不同，冷 dynamic fallback 替换整个窗口 | `issue-workspace.tsx` 与 `settings-shell.tsx` 共用稳定外壳，抽出路由内容；fallback 限定在内容区 | 基线真实截图 + DOM 断开；组件 red→green；9005 冷加载节点保持 | **8 × 5 = 40** |
| Settings 键盘搜索不一致 | 顶栏公开 Cmd/Ctrl+K，但 Settings shortcut 未走离开设置并打开搜索的入口 | 键盘和顶栏共用 `searchFromBar`，保留 IME / dialog / busy guard，设置内裸 C 不创建任务 | 组件 red→green；9005 真实搜索弹层 | **4 × 4 = 16** |
| Back/Forward 错会话 | Ada→Settings→搜索→Back/Back→Forward/Back；router 先 render，空操作 `tidyAddress` 提前更新 `seenQuery`，popstate 跳过 Ada 同步 | `workspace-navigation.write` 只在真正写 history 时更新 seenQuery；不删除 queryMoved 或 dirty guard | 9005 真实失败；组件两种事件顺序及 singleton red→green；最终 UI 待复验 | **5 × 5 = 25** |
| 过期 action 静默硬刷新 | 旧页面收到 removed-action header，自动 reload 丢未提交输入；过早发出的刷新需求还可能错过订阅 | `lib/app-build.ts` 终止旧业务请求流并显式提示；`VersionGuard` 先订阅再读取已有 marker；不自动重载或重放 mutation | build / network 源码回归；晚挂载 UI 组件回归 | **3 × 8 = 24** |
| 后台聊天补读拉到底部 | 历史最大 person message position 增长被当作本地发送；另一标签或补读打断历史阅读 | `coordinator-chat.tsx` 仅对当前 composer 被接受的本地发送递增滚动信号 | 组件 red→green；9005 背景消息保持草稿、焦点、选区和 scrollTop 340 | **7 × 4 = 28** |
| 任务编辑器后台失败 | 已授权 TaskForm 因普通读取失败被整个卸载，丢失未保存输入；拒绝后的 dirty guard 还可能阻止离开 | `task-detail.tsx` 对普通失败保留原编辑器；明确拒绝关闭编辑器并释放 dirty/flush；沿用局部 Retry | 真实 SWR / Y.Doc 组件 red→green | **4 × 8 = 32** |
| 群聊在途 / 失败消息离页丢失 | pending 使用组件本地 useState，设置往返后丢失发送状态或失败待重试文本 | `group-chat-view.tsx` 使用已有 scoped view state，等待同一 promise；只显式 Retry，确认读到 sentId 后清理 | 导航 / late promise / scope 组件 red→green | **5 × 8 = 40** |
| Artifact 已读内容被后台错误替换 | Library error 分支清掉已读列表；Viewer detail/text error 卸载文档或 iframe；正文 Retry 只重读 detail | 普通失败保留同一列表 / 文档 / iframe；流外 toast；Viewer Retry 同时重读 detail 和当前正文版本 key | 基线 Library 真实三态截图；Library / Viewer 真实 SWR red→green | **4 × 5 = 20** |
| 线程读失败中断 / 首载无恢复 | lookup 初载失败一直 skeleton；背景 lookup / detail error 卸载已打开线程与输入 | `thread-column.tsx` / `issue-thread-panel.tsx` 保留已授权内容，首次失败局部 Retry | 组件 red→green；真实新候选 UI 待完成 | **4 × 5 = 20** |
| 撤权后旧内容复活 | 保留旧数据若仅看普通 error，会在拒绝之后的网络失败恢复旧历史；线程缓存的 Changes / Acceptance 及 header 也可能继续露出 | 复用 `readAccessFailure` 与明确拒绝码；锁存拒绝直到成功读清 error；所有已缓存内容分支同样关闭 | 401/403/404、owner/workspace、runNotFound/session changed、null 组件回归 | **3 × 9 = 27** |
| 拒绝后 Retry 跨 remount 卡死 | SWR 同 key 去重只通知旧 mount 的 onSuccess，新页面无法解除拒绝状态 | Library / Group / 线程观察 SWR 的实际成功与 error 清除；后续普通 error 不能解除拒绝 | 两项真实 SWR 先红，当前页面成功读恢复回归通过 | **4 × 5 = 20** |
| Board 过滤名称跨账户 / 工作区 | 共享 localStorage 的 project / label 名称在新 scope 被 chip 原值 fallback 展示，且可能筛空任务 | `board-page.tsx` 把过滤值放入现有 owner/workspace view store；旧无归属 filters 一次性重置，布局偏好保留 | 同 owner 换 workspace / 换 owner / 返回 / 旧存储 4 项真实 render red→green | **5 × 8 = 40** |
| 注销后旧 promise 回填私有状态 | 旧 store setter 在 provider 退出后仍可写；真实清理 helper 漏删 view 键，仅补删键仍被未卸载 setter 回填 | `view-state.tsx` activate/retire；`clearChatDrafts` 同步 retire 当前写入者，再清 draft/view session 键；新登录 provider 正常可写 | provider retirement + 真实 logout helper 两阶段 red→green；logout 顺序回归 | **5 × 8 = 40** |
| 减少动态效果未覆盖 CSS | JS MotionConfig 不控制 Dialog / AlertDialog 缩放与 Skeleton pulse | 沿用 `motion-reduce`：缩放变为 1，Skeleton animation none；弹层淡入淡出保留 | 编译 CSS 核对；9005 计算样式记录；非 iOS 系统验收 | **4 × 4 = 16** |
| 任务评论离页丢失 | 9005 `#issue-comment` 输入→Close→Board→重开，草稿丢失；`issue-activity.tsx` 组件本地 useState | `IssueActivity` 的 comment / reply / reply target 使用既有 scoped store，稳定 task id 经 TaskDetail→IssueEditor 传入；未授权 cached preview 不恢复 Activity 草稿；提交清理语义不变 | Owner 真实浏览器失败；目标 **4 red→green**，完整 DOM 入口 **28/28**；独立 review APPROVE；最终 UI 待复验 | **5 × 7 = 35** |

