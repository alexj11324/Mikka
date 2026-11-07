# Issue #1603：交互连续性验收证据

**当前结论：`9005d8ea` 部分通过，同时复现了历史导航错位和任务评论草稿丢失。候选 `156b6a27` 已包含这两项源码修复，完整类型检查与官方 overlay 生产构建通过；其实际 UI 验收仍为 TODO。** 本页不把 `9005` 截图改标成新候选的通过证据，也不据此宣告 issue 已完成。

本目录记录本地生产模式应用的实际浏览器操作、截图和 HTTP 验收。截图来自隔离测试数据；它们不代表生产共享账号验收、原生桌面应用验收或 iOS 验收。

## 1. 固定版本与证据范围

| 阶段 | 精确源码版本 | 环境与时间（UTC） | 本目录证据及状态 |
| --- | --- | --- | --- |
| 修改前基线 | `f3ef8f4a5f96909e84a719ab3cd4cf2515d57602` | 本地生产模式，`localhost:3111`；2026-11-07 05:39:05–05:44:03；独立测试数据库 | `before/` 的 5 张截图。确认 Settings 冷加载替换外层框架、Artifact 后台失败替换旧列表；该次人工会话完成清理并释放租约。 |
| 中间版本实际 UI | `9005d8eaea561d42a59768846f6abbf46d4d5f19` | 本地生产模式，`localhost:3110`；2026-11-07 06:00:10–06:16:05；隔离测试数据库 | `9005/` 的 14 张截图、[操作观测摘要](9005-observations.json)及[失败摘录](curated-failures.json)。部分通过，两个明确失败；控制器终止后租约按既有规则quarantine；其owned隔离数据库已退役，详情见[退役记录](9005-runtime-retirement.json)。 |
| 最终候选 | `156b6a2779d1ee71161b99ab47b3484e2a8b5704` | 已完成精确候选的类型检查与官方 overlay 生产构建。隔离 final2 数据库已绑定该 SHA；本地 API 首轮因闲置 PG 连接中断而失败，正在修复临时传输环境。实际 UI 与版本探针仍为 TODO。 | `156b/` 预留给本候选的新截图和记录，当前没有该版本实际 UI 通过证据。 |

基线和 `9005` 使用相同的官方验收 overlay：`2cbb930e409ccc247f7692abc9e2dd1152a571fe`。已验证的应用路径为 Vite 前端与 Nitro 服务端；“生产模式构建”指本地构建运行方式，不表示访问生产域名。

`156b6a27` 与本地完成评论草稿回归的 `f797671373f7b5b23a9c10ec8a27d77bf9e45da0` 源码树相同：`43ddc1c57eb0fede3db6cad89d406baa02554597`。这允许准确关联源码检查，不能替代新候选的运行时验收。

## 2. A–D 验收矩阵

| 要求 | 已有实际证据 | 源码／组件证据 | 当前判断与尚待工作 |
| --- | --- | --- | --- |
| **A：固定基线、逐路径检查、真实问题记录** | 基线与 `9005` 均记录精确 SHA、overlay、时间与截图。`9005` 原始记录共 215 条，公开摘要保留必要观测；两个失败另行摘录。 | 问题均对应实际根因与定点回归；本页区分组件验证、实际 UI、HTTP 与生产验收。 | 基线与中间版本记录已具备；**TODO：`156b` 固定环境、实际运行和清理闭环。** |
| **B：稳定外层框架、局部 loading/error** | 基线冷 Settings 加载时 frame/bar/rail 数量均为 0；`9005` 延迟 Settings chunk 8 秒时三者各 1 个且仍为原 DOM。Settings 中命令搜索可打开。 | 稳定 AppFrame、局部 SettingsRouteContent 以及既有 Settings 组件回归。 | 所观测的 `9005` 冷加载路径通过；不能推广为全部导航通过。 |
| **B：地址、Back/Forward 与内容保持一致** | `9005` 第一次 Back 恢复 Ada 草稿及 scrollTop=340；继续 Forward/Back 后，地址仍指向 Ada，主区域却显示 Coordinator。 | `b7a73ab1` 修复 no-op 地址清理提前消费待处理历史查询；导航 24 项、view-state 28 项在该修复阶段通过。 | **`9005` 明确失败。TODO：`156b` 重走完整序列并核对地址、选中项、主内容与草稿。** |
| **C：后台更新与普通失败不破坏在读内容** | 聊天新消息与重连、群聊 503、任务 503、线程 503、Artifact 列表／文档／HTML 的旧内容保留，详见下表。 | 现有聊天、群聊、任务、线程与 Artifact 连续性回归覆盖旧数据、DOM、草稿、拒绝和重试语义。 | `9005` 所列路径通过；**TODO：`156b` 对应复验。** |
| **C：离开／返回时草稿、筛选与局部状态连续** | `9005` Board 返回后保留 Assignee Me、Priority Medium 和 List view；Plugins 详情返回保留 GitHub 搜索词。任务评论离开后重开则丢失。 | `156b` 将普通评论、回复正文、回复目标放入现有按账号／工作区／任务隔离的 view-state；新增 6 项组件用例通过。 | **任务评论在 `9005` 失败。TODO：候选版本实际验证评论、回复和 Board 跨范围隔离。** |
| **C：权限、账号、工作区与退出边界** | 群聊消息读取 403 后历史隐藏、输入禁用；再遇 503 不恢复旧历史；成功重试后恢复。403 后旧全局框架观测点退役，后续改用 frame2/bar2/rail2。 | 任务与线程拒绝锁存、scope 隔离、中央退出清理、仍挂载旧 setter 不回填等组件回归。评论草稿使用真实退出 helper 验证。 | 已有 403 消息读取实际证据和组件证据；**不把它写成完整生产撤权／跨账号／多标签验收。TODO：最终候选对应边界。** |
| **D：局部反馈、减少运动、适配** | 普通失败提供局部 Retry；reduce 媒体下 Settings 的三个 skeleton `animationName=none`，命令弹窗 enterScale=1。有暗色与 390×844 Web 截图。 | 既有 motion-reduce 工具类以及相关组件回归。提交后清空草稿且不自动重放的回归通过。 | 已观测减少 pulse／缩放的结果；淡入仍保留。窄屏图只证明 Web 连续性，**不代表原生移动体验或 iOS 通过**。 |

## 3. 基线与中间版本的视觉对照

### Settings 冷加载

基线原始操作 #23–24：延迟 Settings chunk 后，主框架、顶栏与导航均缺席；数量为 `0 / 0 / 0`。`9005` #20–22：加载骨架限制在内容区，原有 frame/bar/rail 保持连接且数量为 `1 / 1 / 1`。

| 基线 `f3ef8f4a` | 中间版本 `9005d8ea` |
| --- | --- |
| ![基线：Settings 冷加载时顶栏和导航缺席](before/before-settings-loading.webp) | ![9005：Settings 局部加载，顶栏和导航保留](9005/after-settings-loading.webp) |

### Artifact 列表的后台普通失败

基线在已加载列表后注入 503，并通过离线／上线触发读取；旧列表被失败页面替换。`9005` 同类普通后台失败保留列表区域和既有两行。这里确认的是失败时在读内容连续性，不能据此推导权限拒绝也应保留数据。

| 基线 `f3ef8f4a` | 中间版本 `9005d8ea` |
| --- | --- |
| ![基线：后台失败后 Artifact 旧列表消失](before/before-artifact-background-error.webp) | ![9005：后台失败后 Artifact 旧列表仍可见](9005/after-artifact-library-background-error.webp) |

## 4. `9005` 已确认的实际通过范围

下列编号为原始 `operations.jsonl` 的 **1-based 操作序号**；公开的 [9005-observations.json](9005-observations.json) 保留对应 `index`。截图呈现外观，DOM 观测用于判断节点身份、焦点、选区和滚动值。

| 路径 | 具体观测 | 操作编号 |
| --- | --- | --- |
| 冷 Settings 与框架 | Settings chunk 延迟 8 秒，frame/bar/rail 同一 DOM、仍连接、各 1 个；加载后 Preferences 可用。 | #17–22、#31、#43 |
| 聊天后台到达与重连 | 加入 owned fixture 消息后离线／上线，新消息读取到达。input、scroller 和框架同节点；草稿、焦点、选区 `[5,15]` 保留；scrollTop `340 → 340`。 | #54–61 |
| 群聊普通失败 | GET 503 后已展开历史仍在，局部 Retry；input/scroller 同节点，草稿与选区 `[5,10]` 保留，scrollTop `240 → 240`。 | #80–86 |
| 群聊拒绝与恢复 | 消息读取 403 后，再次 Retry 得到 503：历史行数 0、输入禁用；撤去注入故障并成功 Retry 后行数 2、输入恢复，同一草稿仍在。 | #87–97 |
| 任务后台失败 | `issues.pollIssue` 503 后 Comment 与 Task description DOM 保留；Comment 草稿、焦点、选区 `[5,14]` 保留。**这不包含关闭后重开。** | #113–121 |
| 线程后台失败 | `agents.getIssueThread` 503 后输入、历史列表、frame2/bar2/rail2 同节点；草稿、焦点及选区 `[7,17]` 保留。 | #132–139 |
| 窄屏 Web | 视口改为 390×844 后线程输入和列表仍为同节点；bar2/rail2 仍连接但尺寸为 0，符合 CSS 隐藏而非重新挂载。 | #143–145 |
| Board 返回 | 关闭任务详情返回 Board，保留 Assignee Me、Priority Medium、List view。此段没有执行账号／工作区切换。 | #147–150 |
| Plugins 返回 | GitHub 详情中 shell 同节点；Back 后 Search apps 仍为 GitHub，workspace 参数保留。未执行插件配置／授权／工具调用。 | #157–163 |
| Artifact 列表 | 普通 503 后列表与 frame2/bar2/rail2 同节点，已有列表可见。 | #166–172 |
| Artifact 文档 | 元数据及正文读取故障后文档、滚动容器同节点；scrollTop 保持 500，选中文本保留；恢复后仍为同节点及同一位置。 | #180–197 |
| Artifact HTML | 元数据后台读取失败后 iframe 与 frame2/bar2/rail2 保持同节点；没有由该失败重新挂载预览 iframe。 | #202–208 |
| 减少运动 | reduce 媒体查询为 true，三个 skeleton 动画名称均为 none；命令弹窗 enterScale=1、transform=none，保留 enter 淡入。没有把截图当作完整动画时序测量。 | #16、#22、#26 |

聊天截图中的测试 bot 显示 unavailable，因此此路径证明读取、草稿和阅读位置连续性，不证明模型发送成功。窄屏线程截图中的 Retry toast 覆盖输入区下部；它不能作为完整窄屏交互质量通过的证据。

## 5. 两个必须保留的真实失败

机器可读的精简证据在 [curated-failures.json](curated-failures.json)。摘录省略 fixture UUID、完整地址和长篇正文，保留原始操作序号、时间及判定所需字段。

### 5.1 历史导航：地址与内容错位

步骤为 Ada → Settings → 命令搜索 → 返回 Settings → Back Ada → Forward Settings → Back。第一次 Back 的 #37 正常恢复草稿与 scrollTop=340；但 **#42，2026-11-07 06:02:20.892 UTC** 显示：

- 地址仍指向起初选中的 Ada。
- 主区域开头为 Coordinator，输入框为 `Message the Coordinator`，当前草稿为空。
- #43 的 frame/bar/rail 仍是原节点。因此“框架没有重挂载”与“地址内容同步正确”是两个独立结论。

源码修复在 `b7a73ab1`：只有真正发生 URL 写入时才更新已消费的查询标记，no-op 地址清理不提前吞掉待处理的历史变化。候选包含此修复；**实际序列复验仍为 TODO**。

### 5.2 任务评论：保持挂载时保留，关闭再打开时丢失

#114 输入 43 字符的测试评论；#116 和后台失败后的 #120 仍观测到同一草稿、焦点与选区。随后关闭任务详情返回 Board，并重开同一任务。最后 **#215，2026-11-07 06:16:05.862 UTC** 的可访问性快照为：

```text
textbox "Comment":
  /placeholder: Leave a comment…
button "Send comment" [disabled]
```

该快照没有评论内容，发送按钮禁用。#153 的选择器查询只返回空对象，**不把它单独当作测得空字符串的证据**。没有完成一张专用的“丢失后”截图；上面的实际快照与之前保留草稿的截图共同构成修改前证据。

候选 `156b6a27` 将普通评论、回复正文和回复目标放进既有 scoped view-state，通过已验证任务 ID 分区。缓存预览尚未确认当前访问权时不恢复活动区草稿；提交清空已发送草稿，不自动重放。复杂富文本选区评论面板未因本问题扩大修改。**关闭／重开及回复的实际 UI 复验仍为 TODO。**

| 已确认问题 | 出现概率 × 影响（1–10 工程估计） | 证据 |
| --- | --- | --- |
| Settings 冷加载替换框架 | 8 × 5 = 40 | 基线 #15、#23–24；冷 chunk 情况下核心导航缺席 |
| Artifact 后台普通失败替换旧列表 | 4 × 5 = 20 | 基线 #30–38，重连触发 503 后旧列表消失 |
| Back/Forward 地址与主内容错位 | 6 × 6 = 36 | `9005` #37–43，地址与会话内容不一致 |
| 任务未发送评论因普通导航丢失 | 6 × 7 = 42 | `9005` #114、#120、#148、#215，用户输入丢失 |

上述分数不是线上发生率统计，也不用于推迟已确认的数据丢失或权限问题。

## 6. “普通 document reload = 0”的精确含义

`9005` 的首次导航记录 `documentRequests=1`。之后全部已记录该计数的截图／状态仍为 1，直到最后一张 Artifact HTML 故障截图。因此在这段已观测的会话里：**初始 document 请求 1 次，后续额外 document 请求 0 次**。

该结果仅覆盖所记录的会话窗口，不包括主动重新打开应用、另一个环境、原生壳、登录／退出、新候选或控制器结束后的时间；也不自动证明所有 React 节点稳定、地址同步正确或页面永不空白。基线存在一次人为 `goto`，计数由 1 变为 2，这是操作者重开页面，不应混算为产品导航缺陷。

**403 安全清理必须与普通路径分开。** 本次群聊拒绝触发既有全局安全／缓存边界清理，原 `frame/bar/rail` 观测点已退役；#120 对旧引用得到 `sameNode=false`、`connected=false`。随后 #124–126 重新登记 `frame2/bar2/rail2`，后续线程、插件、Artifact 普通导航和失败均以这些新观测点比较。不能把安全边界清理归为普通路由无故重建，也不能忽略它并宣称从初次加载到结束始终只有同一组 shell DOM。

这里的 403 来自群聊消息读取，验证的是该会话的消息与输入关闭／恢复；它不是完整生产工作区撤权、换账号或跨标签同步测试。

## 7. HTTP 验收与清理账目

[9005-api-evidence.json](9005-api-evidence.json) 记录一次真实 HTTP/RPC 验收：2026-11-07 **05:55:25.339–05:58:03.612 UTC**，版本为 `9005d8ea`，服务为生产模式 Nitro。此处沿用 #1372 读缓存入口，所以报告内 `issue` 为 1372；将它用于 #1603 的数据读取证据，不把它改称 UI 验收。

共 **35 次读取**，涵盖版本／范围检查、6 个 cold、6 个 warm、6 个 reload-restored、2 个 peer-denied、2 个 peer-isolation、4 个单行增量、1 个变更、5 个删除及结束版本检查。报告结果为 pass，包括预期的业务权限拒绝；RPC 的 HTTP 200 不等于所有请求都获得私有数据。

报告明确 `businessRequestWrites=false`、`modelExecution=false`、`browserExecution=false`。它证明对应真实 API 行为，不证明视觉、输入、导航、模型执行或最终候选的 UI 已通过。

| 会话 | 清理证据 | 状态 |
| --- | --- | --- |
| 基线人工 UI | 最后 #43：browserClosed=true、fixtureCleanup=true、lease=released；证据审计 passed | 已完成 |
| `9005` HTTP 35-read 验收 | `cleanup.fixtures=succeeded`，`cleanup.lease=released-clean` | 已干净释放 |
| `9005` 人工 UI | 215 条原始记录没有 close 操作；观测摘要标记 `controller-session-ended-before-final-cleanup` | **恢复清理与租约释放确认 pending** |
| `156b` 最终候选 | 尚无该版本新一轮实际 UI 记录 | **TODO：运行及完整清理** |

API 会话的 clean release 不能代替之后人工 UI 会话的清理。控制器终止后尚未执行的请求不能记为已完成操作，也不能补写成功截图或关闭结果。

## 8. 源码验证与 `156b` TODO

评论补修先用真实 IssueActivity 组件得到 **4 red / 1 pass**；加入边界用例后，既有 `test:issue-readonly-dom` 完整入口 **28/28 通过**，包括 9 项 editor/activity 测试和 19 项 TaskDetail 授权、读取及后台失败测试。四个修改文件 oxlint、全局 UI policy（2815 个业务文件、487 个交互文件）及 diff check 均通过。上述结果对应 `f7976713`，其源码树与候选 `156b6a27` 完全相同；独立代码审查无阻断项。

相关源码与测试：

- [任务活动区](../../../../components/workspace/issue-activity.tsx)、[IssueEditor](../../../../components/workspace/issue-editor.tsx)、[TaskDetail](../../../../components/workspace/task-detail.tsx)、[活动区 DOM 回归](../../../../scripts/issue-readonly-dom.test.tsx)。
- [历史导航](../../../../components/workspace/workspace-navigation.ts)、[导航回归](../../../../components/workspace/workspace-navigation.test.ts)、[真实 Settings 组件回归](../../../../components/workspace/issue-workspace-settings.test.tsx)。
- [view-state 与退出生命周期回归](../../../../lib/hooks/view-state.test.tsx)、[Board 范围回归](../../../../components/workspace/board-view-state.test.tsx)。

完整最终类型检查、最终 CI 与新候选实际 UI 尚未由本页确认通过；前一版本结果不自动覆盖后续主线合并。

- [ ] **TODO：环境固定。** 重新构建精确 `156b6a2779d1ee71161b99ab47b3484e2a8b5704`，核对 `/api/version`、overlay、运行来源、隔离数据库、开始时间。
- [ ] **TODO：历史导航。** 完整重复 Ada → Settings → 命令搜索 → Back/Forward 序列，核对 URL、选中项、主内容、草稿及阅读位置；保留新截图和操作观测。
- [ ] **TODO：评论与回复。** 输入未发送评论及回复 → 关闭详情 → 返回 Board → 重开同一任务；检查任务／工作区／账号隔离、提交仅清已发送内容和无自动重放。
- [ ] **TODO：普通路径复验。** Settings 冷加载、聊天后台到达、群聊在途返回与 503、任务／线程 503、Artifact 列表／文档／HTML 失败与恢复、Plugins 返回、Board 筛选保留。
- [ ] **TODO：安全边界。** 拒绝后普通失败不能恢复未授权旧内容；成功授权读取才恢复；退出实际清理链及旧异步回调不得回填。区分合理安全重建与普通导航。
- [ ] **TODO：反馈和界面。** 复查减少运动、暗／亮色、局部 Retry、键盘焦点和窄屏遮挡；只声明实际检查的平台和范围。
- [ ] **TODO：最终门禁与清理。** 记录精确候选的最终类型检查／CI；恢复并关闭旧人工会话的清理；新会话完整退出并记录 fixture 清理与租约释放。
- [ ] **TODO：生产验收。** 合并并确认生产实际服务目标版本后，以已有授权的共享测试账号、正确工作区与真实任务按 issue 要求验收。此目录的本地 fixture 不能替代这一步。

`156b/` 只接收该候选实际新生成的证据。若最终源码版本继续变化，应另记版本或明确源码树对应关系，不移动旧图片造成已验收的假象。

## 9. 图片索引

图片为原始截图的 lossless WebP 转存，展示内容未改绘；下列链接均相对于本目录。测试人物与内容为合成 fixture。本页与失败摘录省略 fixture UUID、完整地址和长篇页面正文；HTTP 报告保留运行与追踪标识，以便关联实际请求。

### 基线 `before/`：5 张

| 图片 | 用途 |
| --- | --- |
| [before-chat](before/before-chat.webp) | 聊天与未发送草稿的基线画面 |
| [before-settings-loading](before/before-settings-loading.webp) | 冷加载缺少顶栏／导航的失败画面 |
| [before-artifact-list](before/before-artifact-list.webp) | 后台失败前的已读列表 |
| [before-artifact-background-error](before/before-artifact-background-error.webp) | 普通后台失败替换旧列表 |
| [before-artifact-recovered](before/before-artifact-recovered.webp) | 撤去故障、重试后恢复 |

### 中间版本 `9005/`：14 张

| 图片 | 用途与限制 |
| --- | --- |
| [Settings loading](9005/after-settings-loading.webp) | 外层框架保留，局部 skeleton |
| [Settings dark](9005/after-settings-dark.webp) | 暗色媒体下的实际画面 |
| [Settings command search](9005/after-settings-command-search.webp) | Settings 内命令弹窗；历史导航后续仍有失败 |
| [Chat background arrival](9005/after-chat-background-arrival.webp) | 背景到达后草稿、选区、阅读位置保留 |
| [Group background error](9005/after-group-background-error.webp) | 普通 503 时保留旧历史与草稿 |
| [Group denied stays closed](9005/after-group-denied-stays-closed.webp) | 403 后再遇 503，历史仍关闭、输入禁用 |
| [Task background error](9005/after-task-background-error.webp) | 挂载期间后台 503 保留评论；不证明关闭再打开保留 |
| [Board detail return](9005/after-board-detail-return.webp) | 返回 Board 的筛选与 List view 保留 |
| [Plugin details](9005/after-plugin-details.webp) | 插件详情导航；没有执行插件授权或调用 |
| [Thread background error](9005/after-thread-background-error.webp) | 线程普通失败保留历史与回复草稿 |
| [Thread narrow web](9005/after-thread-narrow-web.webp) | 390×844 Web 连续性；非 iOS／原生移动验收 |
| [Artifact library error](9005/after-artifact-library-background-error.webp) | 普通后台失败仍保留列表 |
| [Artifact document error](9005/after-artifact-document-background-error.webp) | 文档读取失败仍保留正文与阅读位置 |
| [Artifact HTML error](9005/after-artifact-html-background-error.webp) | 后台读取失败未重新挂载 iframe |

### 最终候选 `156b/`

**TODO：当前尚无该候选的实际 UI 截图、操作记录或通过结论。**


## 最终候选当前验证状态

[构建与内容绑定证据](156b-build-evidence.json)：完整 `pnpm typecheck` exit 0（39.67秒）；`pnpm build:app` exit 0（137.27秒）。实际 build revision 为156b完整SHA，renderer build为 `a60d2a8a19f33b7588ea5f4572a2b4f2c212b6a4a66843fb0375ddb5d9eb60ac`。166个官方overlay源码、资产和文本blob均匹配固定2cbb版本；10个文档PNG不参与构建。

[主CI](https://github.com/alexj11324/Mikka/actions/runs/42347352032)及[API/CLI CI](https://github.com/alexj11324/Mikka/actions/runs/42347352010)已成功；[Desktop CI](https://github.com/alexj11324/Mikka/actions/runs/42347352004)正在完成真实Apple Silicon packaged acceptance。Browser gate是占位，CI中的Production build and browser interactions是DB shard汇总检查；二者不作为实际UI证明。

[本地API首轮失败](156b-local-api-attempt-1.json)与源码CI通过分别记录；不会把旧9005的HTTP摘要改标156b。人工UI须在连接生命周期问题解除后继续。已复现问题、具体根因与修复见[问题登记](defect-register.md)。
