# Issue #1603：交互连续性验收证据

> **2026-11-07 更新：** 主批次 #1619 与第 17 项补修 #1626 已 merge；`26ef4de1` 的历史主干 CI 12/12、Web deploy、Vercel READY、HTTP 200、source/build `26ef4de1` 与官方 overlay `53d30a3` 已独立核实，见[主干 CI](followup-main-ci.json)、[发布证据](followup-release-evidence.json)、[Vercel 绑定](followup-vercel-binding.json)。这些是历史发布事实，生产域名随后随其他 PR 前移，不代表新补修已部署。

> **当前新增修复：** 第 18 项持续失败 Retry 丢失局部恢复入口、第 19 项 hosted Settings 往返丢失待发送批注／电脑线程 registry，均已最小修复并完成本地红绿回归，整合进入 draft [PR #1637](https://github.com/alexj11324/Mikka/pull/1637)。候选 head `6b4a3eb599179b3032e1717fc047d25284c25a9b`、tree `d45d992a4103ce3b144eae1575204e250a94e812`、base `1edbeca687119eb0ef71f209ac3d411fbc85b888`；**本快照尚未 merge，精确候选 CI、新构建 UI、最终部署及指定 SMOKE 生产验收 PENDING**，见[组合候选状态](followup-1637-candidate.json)。

**当前结论：已确认 19 项缺陷，前 17 项已在 [#1619](https://github.com/alexj11324/Mikka/pull/1619)／[#1626](https://github.com/alexj11324/Mikka/pull/1626) 合并，第 18／19 项的最小修复已进入 #1637 待验收候选。** 第 18 项在 `f7225f3e` 基底的真实 React／SWR／Sonner 上为 **8 red → 8 green**；第 19 项以真实 provider 复现批注与 registry 丢失，再通过 **Settings 10/10、既有 view-state 30/30**（10 项包含在 30 项中）。这些单项结果不改标为 `6b4a3eb` 的 CI。主批次候选 `156b`、本地整合 `5a752a50`／overlay `ac598069` 的 296 条操作、23 张截图及清理仍各自绑定原版本；`9005` 的两个实际失败和隔离记录保留。默认折叠 toast 栈本身不是确认缺陷；实际 hover／Alt+T／模态键盘和 composer 可达性仍待新 UI 验收。**Issue #1603 尚未完成，不能据本地通过或历史发布记录关闭。**

本目录记录本地生产模式应用的实际浏览器操作、截图和 HTTP 验收。截图来自隔离测试数据；它们不代表生产共享账号验收、原生桌面应用验收或 iOS 验收。

## 1. 固定版本与证据范围

| 阶段 | 精确源码版本 | 环境与时间（UTC） | 本目录证据及状态 |
| --- | --- | --- | --- |
| 修改前基线 | `f3ef8f4a5f96909e84a719ab3cd4cf2515d57602` | 本地生产模式，`localhost:3111`；2026-11-07 05:39:05–05:44:03；独立测试数据库 | `before/` 的 5 张截图。确认 Settings 冷加载替换外层框架、Artifact 后台失败替换旧列表；该次人工会话完成清理并释放租约。 |
| 中间版本实际 UI | `9005d8eaea561d42a59768846f6abbf46d4d5f19` | 本地生产模式，`localhost:3110`；2026-11-07 06:00:10–06:16:05；隔离测试数据库 | `9005/` 的 14 张截图、[操作观测摘要](9005-observations.json)及[失败摘录](curated-failures.json)。部分通过，两个明确失败；控制器终止后租约按既有规则进入 `quarantined`，`cleanRelease=false`；其 owned 隔离数据库已退役，详情见[退役记录](9005-runtime-retirement.json)。 |
| 候选源码检查与 API | `156b6a2779d1ee71161b99ab47b3484e2a8b5704` | 官方 overlay `2cbb930e`；精确类型检查与构建通过。API 重跑于 07:07:11.880–07:09:45.956 完成，35 次读取通过并干净释放。关联该 head 的 30 项检查为 23 success、7 skipped。 | [构建证据](156b-build-evidence.json)、[API 证据](156b-api-evidence.json)、[CI 审核](156b-ci-review.json)。首轮连接失败另行保留；这些结果不改标为最终手动 UI。 |
| 本地整合版本与最终手动 UI | `5a752a50eb74c22681cd7dd8511ff6d2e58fc46f` | 本地合并 `ad5e5db5` 与候选 `156b6a27`，树 `977111e65ae6bc8c15b88e01810f2f143512c4dd`；官方 overlay `ac598069`；生产构建 exit 0（128.36 秒）。07:19:14.159 UTC 核实 `localhost:3110` 实际服务该 build。 | [整合构建证据](integration-build-evidence.json)、[运行版本绑定](integration-runtime-binding.json)；最终图库 `integrated/` 共 23 张；07:24:29–07:43:02 完成所列 UI 操作，07:44:17 close 确认 fixture 清理与租约释放，见[脱敏观测](integration-observations.json)。该次运行仍包含下文的 switcher 误分类，后续 #1626 已修复；toast 交互证据未完成，不能记为全部要求通过。`5a752a50` 是本地整合提交，不是最终 GitHub merge。 |
| 主批次实际 GitHub merge | `efb95d951ddbeca1af04bc80d011ccbc2a9f0188` | #1619 于 07:58:31 UTC 合并；parents 为最新 main `93724cb9` 与候选 `156b6a27`，树 `fd7fb13f41c5a87df865f539d498b32e3a4fb83b` 与预测一致。 | [主批次合并回读](batch-merge-verification.json)、[合并前最新主干复核](final-main-93724.json)。不把较早 `5a752a50` 的人工 UI 改标为本 SHA 新运行。 |
| 第 17 项服务端误分类后续修复 | `26ef4de15129e22503e152258ee9cb2e4aeae8bd` | #1626 于 08:13:42 UTC 合并；parents 为 `efb95d95` 与修复 head `6ccb50d7`；树 `9cec7cc5dee0fe71eff576e3f84136ca51ed3def` 与通过 CI 的候选树一致。 | [本地 red→green 与范围](switcher-followup-evidence.json)、[4 项 required CI](switcher-ci-review.json)、[实际合并回读](followup-merge-verification.json)。26ef 的[历史发布](followup-release-evidence.json)已核实；无新本地 UI 运行，不替代最终指定账号验收。 |
| 第 18／19 项单项本地修复 | 基底 `f7225f3eb1e38762dfdecde0395792c85b81ec22` 加各自冻结补丁 | Retry 的 7 个回调／8 条真实路径；hosted Settings 的共同 provider 生存期。两个补丁不重叠。 | [Retry 红绿与检查](toast-fix-evidence.json)、[provider 红绿与审查](hosted-provider-review.json)。单项类型检查与测试均绑定 f722 加相应补丁，不等于整合候选 CI 或生产构建。 |
| 第 18／19 项组合候选 | `6b4a3eb599179b3032e1717fc047d25284c25a9b` | draft #1637；base `1edbeca687119eb0ef71f209ac3d411fbc85b888`，tree `d45d992a4103ce3b144eae1575204e250a94e812`，共 16 文件。 | [候选状态](followup-1637-candidate.json)、[1ed 主干增量审查](main-1ed-review.json)。精确候选 CI、新官方 overlay 构建与 UI、merge／部署／生产验收 **PENDING**；不能沿用旧图冒充新运行。 |

基线、`9005` 和候选 `156b` 构建使用官方 overlay `2cbb930e409ccc247f7692abc9e2dd1152a571fe`；本地整合 `5a752a50` 使用更新后的官方 overlay `ac5980696802f188a81124a8a3f2513be2d14e9e`。两组源码／overlay 组合分别记录。已验证的应用路径为 Vite 前端与 Nitro 服务端；“生产模式构建”指本地构建运行方式，不表示访问生产域名。

`156b6a27` 与本地完成评论草稿回归的 `f797671373f7b5b23a9c10ec8a27d77bf9e45da0` 源码树相同：`43ddc1c57eb0fede3db6cad89d406baa02554597`。这允许准确关联源码检查，不能替代新候选的运行时验收。

## 2. A–D 验收矩阵

| 要求 | 实际运行／动态回归证据（各自绑定版本） | 源码／组件证据 | 当前判断与尚待工作 |
| --- | --- | --- | --- |
| **A：固定基线、逐路径检查、真实问题记录** | 基线、9005、156b API、5a 整合 UI 和 f722 单项红绿分别绑定版本；历史整合 296 条操作、23 张截图及清理不变。 | 19 项确认缺陷均有根因与最小修复；前 17 项已 merge，第 18／19 项在 draft #1637。 | **6b4a3eb 精确 CI、新 UI、合并及最终生产验收 PENDING。** 历史 26ef 发布成功不替代当前候选门禁。 |
| **B：稳定外层框架、局部 loading/error** | 5a 的 #15 chunk 延迟 8 秒、#19–20 frame/bar/rail 同节点、Ctrl+K 通过，均为旧 overlay 观察。最新 hosted 设计明确拥有独立 SettingsFrame。 | 第 19 项只把真实 BrowserNotes／ComputerAgents providers 提到两个视觉 frame 的共同父层，保留 OWN_SETTINGS_FRAME=true；Settings 10/10、view-state 30/30。 | 新 hosted 外观下的冷 chunk／导航 UI **PENDING**；不要求不同设计的 frame 与旧截图同节点，也不把旧壳证据套到新 overlay。 |
| **B：地址、Back/Forward 与内容保持一致** | #27–36 完整重走 Back/Back/Forward/Back；Ada URL 与输入一致，草稿保留，scrollTop=340，shell 同节点，documentRequests=1。 | `b7a73ab1` 修复 no-op 地址清理提前消费历史查询；两种事件顺序组件回归。 | `9005` 的真实失败已在 `5a752a50` 复验修复。 |
| **C：后台更新与普通失败不破坏在读内容** | 5a 所列聊天／任务／线程／群聊／Artifact 503 保留内容和相应节点。另在 f722 真实组件中复现持续失败 Retry 后恢复按钮消失。 | #1626 已修 switcher 未知异常误报 403；第 18 项 7 个回调同步 preventDefault，8 条路径 red→green，持续失败保留 Retry、成功后原 effect dismiss。 | 第 18 项本地组件证据完成；**组合 6b4a3eb 新 UI PENDING**。旧图库不改标，未据 Node/Happy DOM 声称实际指针或几何交互通过。 |
| **C：离开／返回时草稿、筛选与局部状态连续** | 评论与回复关闭／重开后恢复；3 次真实提交仅清相应草稿；Plugins 保留 GitHub 搜索；换工作区隔离 Medium／APP-1／草稿，返回原工作区恢复 Medium／List 和任务评论草稿。 | scoped view-state、稳定任务 ID、未授权 cached preview 不恢复 Activity，相关隔离回归。 | 本次同账号两工作区操作通过；跨账号与多标签仅有对应组件／既有 API 证据。 |
| **C：权限、退出与显式升级边界** | 群聊 403→503 继续隐藏历史并禁用输入，成功 Retry 才恢复。removed-action 提示前 documentRequests=1、草稿在；显式 Refresh 后=2、草稿恢复、群聊 POST 未重放。真实 Sign out 后 view keys 68→0。 | 拒绝锁存、provider retirement、退出 helper 与旧 setter 不回填回归。 | 明确安全拒绝与显式刷新按本次范围通过；#1626 只修服务端未知错误分类，真实 401／403 的客户端拒绝策略保留。 |
| **D：局部反馈、减少运动、适配** | 旧 5a 的 reduce、暗／亮色及 390×844 输入／Send 观察保留。第 18 项已实际验证错误持续时 Retry 不消失、成功时收回。 | [Retry 最小修复与 8 条真实回归](toast-fix-evidence.json)完成；不修改 toast 布局、轮询或缓存策略。 | **实际折叠栈展开、Artifact 模态键盘、composer 可达性及新窄屏 UI PENDING**。默认栈行为不登记为缺陷；窄屏 Web 仍不代表 iOS／原生移动验收。 |

## 第 18／19 项组合候选与验证边界

[#1637](https://github.com/alexj11324/Mikka/pull/1637) 将两个独立补丁接到实际 main `1edbeca6`，形成 `6b4a3eb`。从本地验证基底 `f7225f3e` 到 `1edbeca6` 前移 15 个提交、49 个文件；与 16 文件组合补丁唯一重叠的是 `package.json`，分别修改 `test:project-decisions` 和 `test:artifacts`，锁文件及既有非重叠补丁文件 blob 未变。该[增量审查](main-1ed-review.json)支持最小补丁兼容性，不等于验证全部新 main 行为。

| 层级与版本 | 已有证据 | 当前结论 |
| --- | --- | --- |
| 第 18 项，f722 加 Retry 补丁 | 8 条路径全部在真实缺失 Retry 断言处红灯，再 8/8 绿灯；`test:artifacts` 48/48（包含新增 8 项）、`test:groups` 90 pass／1 既有 DB skip、`test:issue-readonly-dom` 28/28；完整 root／API／frontend typecheck、定向 lint、UI／error／polling policy 通过 | **本地修复验证完成**；未启新浏览器、DB 或 live model。详见 [toast-fix-evidence.json](toast-fix-evidence.json)。 |
| 第 19 项，f722 加 provider 补丁 | 实际 IssueWorkspace＋真实 providers 的精确红灯显示文字草稿在、批注 `[]`、registry `null`；修复后 Settings 10/10、既有 view-state 命令 30/30；root `tsrs --noEmit` 与两文件 lint 通过 | **本地修复验证完成**；10 项已包含在 30 项中。hosted frame 使用 slot fixture，未把它当成私有 overlay 的浏览器验收。详见 [hosted-provider-review.json](hosted-provider-review.json)。 |
| 组合候选 6b4a3eb，base 1edbeca6 | 16 文件候选及精确 head／tree 已登记；计划使用兼容官方 overlay e290220f | **精确候选 CI、生产构建及实际 served 版本绑定 PENDING**；f722 单项 typecheck 不改标为本候选运行。 |
| 新构建 UI、merge、最终生产 | 待完成持续失败 Retry／成功 dismiss、hosted Settings 状态与局部加载，以及既定交互路径 | **PENDING**；本快照 PR 仍 draft、尚未 merge。旧 5a 图库、26ef 历史发布和 Node 单测不替代这些门禁。 |

第 18 项发生 **4 × 影响 5 = 20**：继续失败会失去可见错误及即时重试，但内容保留，后续自动恢复／导航仍可能工作，不称永久死锁。第 19 项发生 **4 × 影响 7 = 28**：hosted Settings 往返会丢未发送批注及电脑线程 registry，独立文字草稿未丢失。两者均为 1–10 工程估计，以[缺陷登记](defect-register.md)为准；最小修复不扩大布局、缓存、轮询或权限策略。

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

### 最终本地整合 `5a752a50` 的实际复验

[整合观测摘要](integration-observations.json)从 **296 条实际记录**中保留 200 条脱敏选摘，编号沿用该运行的 1-based 原始序号；没有把 `9005` 的通过结果改标为新版本。运行从 07:24:29.225 UTC 开始，最后 UI 截图为 07:43:02.835，07:44:17.519 完成 close。

| 路径 | 最终实际观测 | 操作编号 |
| --- | --- | --- |
| 冷 Settings／命令搜索／历史 | 8 秒 chunk 延迟；三个 shell 节点同一且各 1 个。完整 Back/Back/Forward/Back 后 Ada 地址、可见输入和草稿一致，scrollTop=340；普通路径额外 document 请求为 0。 | #15–36 |
| Thinking 与工具详情 | 展开 stored reasoning、工具分组、单工具；Expand all／Collapse all 分别变为 true／false。再次 Expand all 后后台消息到达仍 expanded=true，工具组 DOM 不变。有亮／暗色画面。 | #37–48、#58–73 |
| 聊天后台到达 | 两条 owned fixture 消息最终均可见；input、scroller、工具组仍同节点，草稿与焦点、选区 `[5,15]` 保留，scrollTop `340→340`。 | #55、#65、#68–73 |
| 评论／回复关闭重开 | 普通评论及回复正文／目标均恢复。两次 Send comment 和一次 Send reply 实际写入合成任务；发评论只清评论并保留未发回复，发回复清回复；重开后仅见三段已提交文本，输入为空。 | #87–114 |
| 任务后台 503 | pollIssue 故障命中 8 次；title、comment 与 shell 同节点；草稿、焦点、选区 `[5,14]` 保留。 | #115–125 |
| 线程后台 503／窄屏 | getThreadChanges 故障命中 4 次；input/list/shell 同节点，焦点、草稿和选区 `[7,17]` 保留。390×844 时顶栏／导航仍连接而尺寸为 0；最终窄屏图无 toast 遮挡输入或 Send。 | #129–143 |
| Plugins 返回 | GitHub 详情→Back，搜索词 GitHub 保留；以环境恢复后新登记的 shell 节点比较，均未变化。 | #154–163 |
| Artifact Library | listArtifacts 503 后列表和新 shell 节点保持；原条目仍可见，局部 Retry 存在。 | #167–174 |
| Artifact Markdown | detail/text 503 后文档与滚动容器保持同节点，scrollTop=650、选中文本保留；故障仍启用时用 Enter 操作 Retry，随后移除故障仍保留位置。**移除故障后的成功正文响应没有单独断言。** | #179–195 |
| Artifact HTML | detail 503 后 iframe 和新 shell 保持同节点；没有该错误导致的 iframe 重挂载。 | #199–206 |
| 群聊在途／普通失败 | POST 延迟 5 秒后受控 503，只命中 1 次；发送期间离开到 Ada 再返回，失败消息仍在 DOM。GET503 后草稿、焦点、选区 `[5,10]` 保留，scrollTop=240。 | #212–234 |
| 群聊拒绝／恢复 | GET403 后历史为 0、输入 disabled；改为 GET503 再 Retry 仍不恢复旧历史；移除故障后成功授权 Retry 恢复，画面可见 Not sent／Retry 和保留草稿。 | #236–250 |
| removed-action 升级 | 404 加 `x-nextjs-action-not-found:1` 仅命中 1 次，出现显式更新对话框；点击 Refresh 前 shell 同节点、草稿在、document=1；点击后 document=2、草稿恢复；群聊 POST 仍只有 1 次。 | #252–269 |
| 工作区隔离／返回 | 真实选择 Continuity alternate：Medium 筛选、APP-1 与旧输入不出现，Coordinator 为空。返回 Desktop acceptance：Medium／List 恢复，评论 `Issue 1603 task background draft` 恢复。两次 scope assign／redirect 的 document 计数 `2→4→6`。 | #270–288 |
| 实际退出／回收 | Sign out 到达登录页；view keys `68→0`，draft prefix 原本为空且仍为 `0`。close 返回 browserClosed／fixtureCleanup=true、lease=released，证据审计 passed。 | #289–296 |

**合成内容与真实操作分开。** 认证、HTTP／RPC、生产构建和 UI 操作是真实的；人物、任务、文档、8 条 stored reasoning／tool activity 消息、2 条后台到达消息及备用工作区 Coordinator 的 2 条消息是 owned fixture。stored tool 不执行工具，未调用 live model。人工 UI **确实发生 2 次评论和 1 次回复的业务写入**，所以不能套用 API 35-read 报告的 `businessRequestWrites=false`；群聊 POST 在临时受控边界返回 503，没有触达模型。

**视觉与操作证据仍有限定。** Artifact 列表／Markdown／HTML 图中，全局 “Can't reach Mikka” 位于折叠 toast 栈前排，局部 Retry 属于后排 toast；部分全宽画面也确实与输入角落重叠。[真实 Sonner 1.7.4 源码复核](toast-source-review.json)确认 hover／mousemove 或 Alt+T 可展开栈，同 ID 更新不自动改变顺序。因此，未 hover 即点击后排按钮而被拦截的 helper 不能证明永久遮挡或键盘死锁；实际模态窗口内的键盘可达性与展开后的 composer 使用仍待验收。仅最终窄屏线程图支持该时刻“输入和 Send 无遮挡”。`group-pending-and-draft` 图停在较早历史位置，失败待重试项在 DOM 底部而未入画；`group-recovered` 图实际展示 Not sent／Retry。错误 locator 或被拦截的 helper 均保留为未完成操作，不改写为通过。独立的“Retry 再失败后通知消失”随后已在 26ef／f722 的真实 Sonner／SWR 动态复现，并作为第 18 项在 #1637 完成最小修复与 8 red→8 green；这些组件证据不改写本段 5a 截图的实际观察。

## 5. 两个必须保留的真实失败

机器可读的精简证据在 [curated-failures.json](curated-failures.json)。摘录省略 fixture UUID、完整地址和长篇正文，保留原始操作序号、时间及判定所需字段。

### 5.1 历史导航：地址与内容错位

步骤为 Ada → Settings → 命令搜索 → 返回 Settings → Back Ada → Forward Settings → Back。第一次 Back 的 #37 正常恢复草稿与 scrollTop=340；但 **#42，2026-11-07 06:02:20.892 UTC** 显示：

- 地址仍指向起初选中的 Ada。
- 主区域开头为 Coordinator，输入框为 `Message the Coordinator`，当前草稿为空。
- #43 的 frame/bar/rail 仍是原节点。因此“框架没有重挂载”与“地址内容同步正确”是两个独立结论。

源码修复在 `b7a73ab1`：只有真正发生 URL 写入时才更新已消费的查询标记，no-op 地址清理不提前吞掉待处理的历史变化。候选及本地整合版本均包含此修复；**`5a752a50` 已在 #27–36 重走完整序列，Ada URL／内容、草稿与 scrollTop=340 均一致，见[新截图](integrated/integrated-history-forward-back-restored.webp)**。

### 5.2 任务评论：保持挂载时保留，关闭再打开时丢失

#114 输入 43 字符的测试评论；#116 和后台失败后的 #120 仍观测到同一草稿、焦点与选区。随后关闭任务详情返回 Board，并重开同一任务。最后 **#215，2026-11-07 06:16:05.862 UTC** 的可访问性快照为：

```text
textbox "Comment":
  /placeholder: Leave a comment…
button "Send comment" [disabled]
```

该快照没有评论内容，发送按钮禁用。#153 的选择器查询只返回空对象，**不把它单独当作测得空字符串的证据**。没有完成一张专用的“丢失后”截图；上面的实际快照与之前保留草稿的截图共同构成修改前证据。

候选 `156b6a27` 将普通评论、回复正文和回复目标放进既有 scoped view-state，通过已验证任务 ID 分区。缓存预览尚未确认当前访问权时不恢复活动区草稿；提交清空已发送草稿，不自动重放。复杂富文本选区评论面板未因本问题扩大修改。**本地整合 `5a752a50` 的 #87–114 已实际验证关闭／重开、回复目标和正文恢复，以及提交分别清空相应草稿，见[评论恢复](integrated/integrated-task-comment-restored.webp)和[评论／回复同时恢复](integrated/integrated-task-reply-and-comment-restored.webp)。**

| 已确认问题 | 出现概率 × 影响（1–10 工程估计） | 证据 |
| --- | --- | --- |
| Settings 冷加载替换框架 | 8 × 5 = 40 | 基线 #15、#23–24；冷 chunk 情况下核心导航缺席 |
| Artifact 后台普通失败替换旧列表 | 4 × 5 = 20 | 基线 #30–38，重连触发 503 后旧列表消失 |
| Back/Forward 地址与主内容错位 | 5 × 5 = 25 | `9005` #37–43，地址与会话内容不一致 |
| 任务未发送评论因普通导航丢失 | 5 × 7 = 35 | `9005` #114、#120、#148、#215，用户输入丢失 |

上述分数与[完整问题登记](defect-register.md)使用同一组工程估计，不是线上发生率统计，也不用于推迟已确认的数据丢失或权限问题。

## 6. “普通 document reload = 0”的精确含义

`9005` 的首次导航记录 `documentRequests=1`。之后全部已记录该计数的截图／状态仍为 1，直到最后一张 Artifact HTML 故障截图。因此在这段已观测的会话里：**初始 document 请求 1 次，后续额外 document 请求 0 次**。

该结果仅覆盖所记录的会话窗口，不包括主动重新打开应用、另一个环境、原生壳、登录／退出、新候选或控制器结束后的时间；也不自动证明所有 React 节点稳定、地址同步正确或页面永不空白。基线存在一次人为 `goto`，计数由 1 变为 2，这是操作者重开页面，不应混算为产品导航缺陷。

**403 安全清理必须与普通路径分开。** 本次群聊拒绝触发既有全局安全／缓存边界清理，原 `frame/bar/rail` 观测点已退役；#120 对旧引用得到 `sameNode=false`、`connected=false`。随后 #124–126 重新登记 `frame2/bar2/rail2`，后续线程、插件、Artifact 普通导航和失败均以这些新观测点比较。不能把安全边界清理归为普通路由无故重建，也不能忽略它并宣称从初次加载到结束始终只有同一组 shell DOM。

这里的 403 来自群聊消息读取，验证的是该会话的消息与输入关闭／恢复；它不是完整生产工作区撤权、换账号或跨标签同步测试。

### 本地整合会话的连续性与连接恢复边界

下列编号属于 `5a752a50`／overlay `ac598069` 的最终运行，与 `9005` 分开。所列普通路径的 document 请求从初始 1 次一直保持 1；显式 Refresh 后为 2，两次真实工作区切换及重定向后分别为 4、6。**这些额外请求是实际计数，不删去也不混称普通导航；document 不增加也不等于 React 子树永不重建。**

| 操作与时间（UTC） | 已确认观测 | 结论边界 |
| --- | --- | --- |
| #136，07:31:04.026；#137 截图 | 线程普通 503 后 frame／bar／rail／input／list 全部 sameNode=true 且连接，输入聚焦、草稿及选区 `[7,17]` 保留。 | 该次已授权线程的普通背景失败保持连续。 |
| #138–140，07:31:05.851–07:31:07.363 | 390×844 后上述节点仍相同，bar／rail 为 CSS 隐藏；实际窄屏图的输入／选区／Send 完整且没有 toast。 | 只验证窄屏 Web，不外推 iOS 或模型发送。 |
| #143，07:31:22.281 的浏览器事件窗口 | 保存了 13 个 `/mikka/api/rpc`／`workspace` HTTP500，documentRequests=1。 | 窗口有限，未包含下述 server403；不能据此声称同期没有授权拒绝响应。 |
| 服务端 07:31:12.114 | `/api/workspace/switcher` 实际返回 403；07:31:12–14 同时有 23 个应用 HTTP500，安全日志提取确认 `Connection terminated unexpectedly`，所检窗口没有 401。 | PG／临时传输异常与 switcher403 同期。没有导出 SQL、参数或凭证；switcher 被 catch 的具体异常未单独留下类型。 |
| #146–147，07:35:36.466–07:35:37.543 | 明确点击全局 Retry now 后，读取旧引用为 sameNode=false／connected=false；#152 仍 documentRequests=1，页面可操作。 | 最后同节点是 #139，首次失效是 #147，中间未连续观测，不能确定精确重建瞬间，更不能说 Retry 必然触发重建。 |

[全局连接提示](../../../../apps/desktop/src/renderer/app.tsx)的 Retry now 调用 `SessionApplication.reload()`→[readBootstrap](../../../../apps/desktop/src/renderer/bootstrap.ts)→`desktop.bootstrap`，不做 document reload；同 owner／workspace 的普通 reload 也不无条件清空 bootstrap。

**历史根因已确认，服务端分类已在 #1626 合并修复。** 本地 `5a752a50` 当时的 [route](../../../../app/api/workspace/switcher/route.ts) catch-all 将 `getApiSession`／`loadWorkspaceSwitcher` 的任意异常统一返回 403，包括未知数据库／连接异常。客户端 [SettingsReadError](../../../../lib/settings-data.ts)保留 403；[readAccessFailure](../../../../lib/swr/persistent-cache.ts)据此按 workspace 拒绝使 provider 失效，[AuthenticatedReadCache](../../../../components/authenticated-read-cache.tsx)增加 generation 并 refresh，退役子树。后续修复保留无会话 401 与真实 `WorkspaceError` 403，将其他异常返回 500／`workspaceReadFailed`，所有分支 `private, no-store`，日志仅错误类。**真实 403 继续拒绝旧私有内容，客户端安全策略没有放宽。** 当次服务端 403 与旧路径相符，普通 500 本身不触发这条失效规则；该次具体 throw 及精确重建时刻仍未被补写为已知。

**第 17 项状态：FIXED AND MERGED。** [本地证据](switcher-followup-evidence.json)记录既有 `pnpm test:settings-backend` 的 34 项先 32 pass／2 fail（未知错误实际返回 403，而预期 500），修复后 34/34 pass；完整类型检查、lint、error-cause policy 与 diff check 通过。两个修改文件在本地基底 `156b` 与实际主批次 merge `efb95d95` 的原始 blob 相同，仅将该两文件补丁接到真实 merge 之上。[后续 CI](switcher-ci-review.json)的 4 项 required check 全部 success，共 17 项为 16 success／1 conditional skip；[#1626 合并回读](followup-merge-verification.json)确认实际 merge `26ef4de1` 的树与 CI head `6ccb50d7` 一致。该服务端后续修复没有新本地 UI 运行；26ef 的历史部署版本已在[发布证据](followup-release-evidence.json)与[Vercel 绑定](followup-vercel-binding.json)核实。新增第 18／19 项候选的合并部署和指定 SMOKE 生产验收仍 PENDING。

环境恢复后重新登记 `frameAfterTransport/barAfterTransport/railAfterTransport`，后续 Plugins／Artifact／群聊普通失败按新基线比较；明确群聊 403 后再登记 `AfterSecurity`。旧 detached 输入对象保留 value 不能单独证明新 live input 已恢复；本页只用后续实际 live input 观测证明 Ada 和任务评论草稿恢复，不把旧对象值冒充新输入验证。

## 7. HTTP 验收与清理账目

[9005-api-evidence.json](9005-api-evidence.json) 记录一次真实 HTTP/RPC 验收：2026-11-07 **05:55:25.339–05:58:03.612 UTC**，版本为 `9005d8ea`，服务为生产模式 Nitro。此处沿用 #1372 读缓存入口，所以报告内 `issue` 为 1372；将它用于 #1603 的数据读取证据，不把它改称 UI 验收。

共 **35 次读取**，涵盖版本／范围检查、6 个 cold、6 个 warm、6 个 reload-restored、2 个 peer-denied、2 个 peer-isolation、4 个单行增量、1 个变更、5 个删除及结束版本检查。报告结果为 pass，包括预期的业务权限拒绝；RPC 的 HTTP 200 不等于所有请求都获得私有数据。

报告明确 `businessRequestWrites=false`、`modelExecution=false`、`browserExecution=false`。它证明对应真实 API 行为，不证明视觉、输入、导航、模型执行或最终候选的 UI 已通过。

**候选 `156b` 已独立完成真实 API 重跑。** [156b-api-evidence.json](156b-api-evidence.json)记录 2026-11-07 **07:07:11.880–07:09:45.956 UTC** 的生产模式 HTTP 验收：`readCount=35`、`status=pass`、进程 exit 0，使用独立 `final3` 数据库；fixture 清理 succeeded，租约 released-clean。该报告同样沿用 #1372 的既有 API 入口，明确没有业务请求写入、模型执行或浏览器执行。传输续接保持同一进程、同一 PostgreSQL 连接，没有 stdin replay。这是 `156b` 的新运行结果，不是把 `9005` 摘要改标，也不属于 `5a752a50` 手动 UI。

| 会话 | 清理证据 | 状态 |
| --- | --- | --- |
| 基线人工 UI | 最后 #43：browserClosed=true、fixtureCleanup=true、lease=released；证据审计 passed | 已完成 |
| `9005` HTTP 35-read 验收 | `cleanup.fixtures=succeeded`，`cleanup.lease=released-clean` | 已干净释放 |
| `9005` 人工 UI | 215 条原始记录没有 close 操作；租约已过期并进入 `quarantined`，`cleanRelease=false`；全部旧 fixture 数据随该 owned 隔离数据库退役移除，见[退役记录](9005-runtime-retirement.json) | **隔离与数据库退役已完成；不是干净释放** |
| `156b` 本地 API 首轮 | [失败记录](156b-local-api-attempt-1.json)：exit 1，PG 连接意外终止，没有生成该次 HTTP 验收摘要 | **失败记录保留；后续成功运行不补写这次的成功或干净释放** |
| `156b` 本地 API 重跑 | [新运行记录](156b-api-evidence.json)：35 reads pass、exit 0；`cleanup.fixtures=succeeded`，`cleanup.lease=released-clean` | **已通过并干净释放** |
| 本地整合 `5a752a50` 人工 UI | [脱敏观测](integration-observations.json) #296：07:44:17.519，browserClosed=true、fixtureCleanup=true、lease=released，证据审计 passed（25 个原始文件）；[最终运行回收](integration-runtime-cleanup.json)独立确认业务 fixture 已清、53 项资源标记 cleaned、created=0，应用连接=0，应用／控制器／relay／Docker 已停止 | **实际 close、业务 fixture 清理、租约释放和临时计算停止已完成** |

[最终回收报告](integration-runtime-cleanup.json)中的 clean 指业务 fixture 已移除及租约干净释放；托管测试池保留 2 个身份与 1 个已失效 session 记录，active retained session=0，不宣称数据库所有行归零。

API 会话的 clean release 不能代替之后人工 UI 会话的清理。旧人工会话的数据库退役结束了该隔离环境的数据生命周期，但没有补成一次成功 close 或 clean release。控制器终止后尚未执行的请求不能记为已完成操作，也不能补写成功截图或关闭结果。

## 8. 源码验证与最终整合验收待办

评论补修先用真实 IssueActivity 组件得到 **4 red / 1 pass**；加入边界用例后，既有 `test:issue-readonly-dom` 完整入口 **28/28 通过**，包括 9 项 editor/activity 测试和 19 项 TaskDetail 授权、读取及后台失败测试。四个修改文件 oxlint、全局 UI policy（2815 个业务文件、487 个交互文件）及 diff check 均通过。上述结果对应 `f7976713`，其源码树与候选 `156b6a27` 完全相同；独立代码审查无阻断项。

相关源码与测试：

- [任务活动区](../../../../components/workspace/issue-activity.tsx)、[IssueEditor](../../../../components/workspace/issue-editor.tsx)、[TaskDetail](../../../../components/workspace/task-detail.tsx)、[活动区 DOM 回归](../../../../scripts/issue-readonly-dom.test.tsx)。
- [历史导航](../../../../components/workspace/workspace-navigation.ts)、[导航回归](../../../../components/workspace/workspace-navigation.test.ts)、[真实 Settings 组件回归](../../../../components/workspace/issue-workspace-settings.test.tsx)。
- [view-state 与退出生命周期回归](../../../../lib/hooks/view-state.test.tsx)、[Board 范围回归](../../../../components/workspace/board-view-state.test.tsx)。

精确候选 `156b` 的完整类型检查、官方 overlay 生产构建与真实 API 重跑均已通过，见[构建证据](156b-build-evidence.json)和[API 证据](156b-api-evidence.json)。2026-11-07 07:01:03.187 UTC 的[最终 CI 审核快照](156b-ci-review.json)确认，关联该 head 的检查为 **23 success、7 skipped**，没有失败或仍在运行的检查；其中 Desktop 的真实 Apple Silicon packaged acceptance 已通过。本地另将 main `ad5e5db5` 与候选整合为 `5a752a50`，已完成新 overlay 下的构建、运行绑定及本页限定范围的手动 UI，并实际清理释放。**各版本的检查范围分开记录，均不替代合并后生产验收。**

- [x] **历史 156b 候选源码检查与构建。** `pnpm typecheck` 和 `pnpm build:app` 均 exit 0；源码 SHA、renderer build 与官方 overlay 内容已绑定。
- [x] **历史 156b 候选 CI。** [主 CI](https://github.com/alexj11324/Mikka/actions/runs/42347352032)、[API/CLI CI](https://github.com/alexj11324/Mikka/actions/runs/42347352010)及[Desktop CI](https://github.com/alexj11324/Mikka/actions/runs/42347352004)均 success；所有关联候选的检查已结束，适用范围见文末。
- [x] **候选本地 API 重跑。** 精确 `156b` 的 35-read 真实验收 pass，exit 0，fixture 与租约干净释放；首轮失败独立保留。
- [x] **本地整合构建。** `5a752a50`（`ad5e5db5` + `156b6a27`）配合官方 overlay `ac598069`，`pnpm build:app` exit 0，用时 128.36 秒。
- [x] **本地整合运行绑定。** 07:19:14.159 UTC 确认 source、compiledBuild、servedBuild 均为 `5a752a50`，renderer 与 overlay 一致；使用独立 `final4` 数据库。
- [x] **旧 `9005` 人工环境处置。** 过期租约保持隔离，owned 数据库已退役；保留 `cleanRelease=false` 的实际结论。
- [x] **整合版本历史导航。** #27–36 完整序列通过；地址／Ada 内容／草稿／scrollTop=340 一致。
- [x] **整合版本评论与回复。** #87–114 关闭重开恢复，真实提交分别清草稿；#278／#287 同账号跨工作区隔离与返回恢复。未宣称手动跨账号验收。
- [x] **整合版本所列普通路径。** 冷 Settings、聊天到达、群聊在途返回和 503、任务／线程 503、Artifact 列表／文档／HTML 连续性、Plugins 和 Board 返回均已有本版本操作证据。
- [x] **整合版本安全与显式升级。** 群聊 403→503 保持拒绝，成功授权 Retry 才恢复；removed-action 只在点击 Refresh 后重载、草稿恢复、没有群聊发送重放；实际 Sign out 清理 view keys。旧 callback 回填仍使用独立组件证据。
- [x] **整合版本界面观察。** 所列减少运动、暗／亮色和最终窄屏输入观察已完成；折叠 toast 栈的交互可达性仍另列待验收，不把截图重叠直接判为永久死锁。
- [x] **整合会话清理。** #296 实际 close，fixtureCleanup=true、lease=released、证据审计 passed。旧 `9005` 仍保持隔离／退役结论，未补成正常 close。
- [x] **第 17 项 switcher 错误分类已修复并合并。** #1626 仅修服务端分类及既有路由回归；本地 34 项 red→green、4 项 required CI 成功、实际 merge `26ef4de1` 与测试树一致，真实授权拒绝策略保持。
- [x] **第 18 项最小修复与本地红绿。** f722 加补丁，7 处 action／8 条真实路径 8 red→8 green；持续失败保留 Retry、成功后收回，见 [Retry 证据](toast-fix-evidence.json)。
- [x] **第 19 项最小修复与本地红绿。** f722 加补丁，真实批注／registry 丢失红灯→Settings 10/10、view-state 30/30；保留 hosted 独立外观和权限边界，见 [provider 证据](hosted-provider-review.json)。
- [ ] **PENDING：组合候选 6b4a3eb 的精确 CI、官方 overlay 构建及运行绑定。** 不用 f722 的单项检查替代新候选门禁。
- [ ] **PENDING：新构建 UI 与 toast 交互证据。** 验证持续失败 Retry／成功 dismiss、hosted Settings 往返与局部 loading；实际 hover／Alt+T／Artifact 模态键盘及 composer 可达性仍待验收。默认折叠栈本身不是确认缺陷。
- [x] **前 17 项 GitHub 合并与回读。** [#1619](batch-merge-verification.json) 实际 merge `efb95d95`；[#1626](followup-merge-verification.json) 实际 merge `26ef4de1`。最新 main 的独立变化已在 [93724 复核](final-main-93724.json)中评估，合并 parent／tree 与候选关系已核实。
- [x] **历史 26ef 发布与绑定。** [主干 CI](followup-main-ci.json)、[Web 发布](followup-release-evidence.json)及[Vercel source／build 绑定](followup-vercel-binding.json)已核实；不据此推定后来移动的生产域名仍服务该版本。
- [ ] **PENDING：#1637 合并与最终部署。** 当前 draft head 为 6b4a3eb；需要门禁通过后的实际 merge parent／tree 回读，以及生产实际服务包含新修复的目标版本。
- [ ] **PENDING：指定 SMOKE 账号生产验收。** 部署版本确认后，以 issue 指定且已有授权的 SMOKE 账号、正确工作区和真实任务验收；本地 fixture、较早主干部署及 API 报告不替代该步骤。

最终手动 UI 图库命名为 `integrated/`，绑定本地整合 `5a752a50` 与 overlay `ac598069`。若源码或 overlay 继续变化，应另记精确版本或明确源码树对应关系，不移动旧图片造成已验收的假象。前 17 项的 GitHub merge 已在主批次／后续回执中记录；第 18／19 项 #1637 的实际 merge、最终部署及生产验收仍待完成。

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

### 最终手动 UI 图库 `integrated/`：23 张

本地整合 `5a752a50`／overlay `ac598069` 的实际截图；完整时间和原始操作号见[整合观测](integration-observations.json)。图片只证明所示画面，节点、焦点和请求计数以对应观测为准。

| 图片 | 用途与限制 |
| --- | --- |
| [integrated-settings-cold-loading](integrated/integrated-settings-cold-loading.webp) | 冷 Settings 局部 skeleton；框架保留（#21） |
| [integrated-settings-command-search](integrated/integrated-settings-command-search.webp) | Settings 内 Ctrl+K 打开命令搜索（#25） |
| [integrated-history-forward-back-restored](integrated/integrated-history-forward-back-restored.webp) | 完整 Forward／Back 后 Ada、草稿、阅读位置一致（#36） |
| [integrated-thinking-tools-expanded](integrated/integrated-thinking-tools-expanded.webp) | 合成 stored reasoning／工具详情展开；没有 live tool（#41） |
| [integrated-thinking-tools-dark](integrated/integrated-thinking-tools-dark.webp) | 同类工具详情暗色画面（#43） |
| [integrated-chat-background-preserved](integrated/integrated-chat-background-preserved.webp) | 后台消息到达时草稿、焦点、选区、scrollTop 保留（#70） |
| [integrated-task-comment-restored](integrated/integrated-task-comment-restored.webp) | 任务关闭重开后普通评论恢复（#93） |
| [integrated-task-reply-and-comment-restored](integrated/integrated-task-reply-and-comment-restored.webp) | 回复目标／正文与独立普通评论同时恢复（#105） |
| [integrated-task-background-error](integrated/integrated-task-background-error.webp) | 任务后台 503 保留评论与标题节点（#124） |
| [integrated-thread-background-error](integrated/integrated-thread-background-error.webp) | 线程后台 503 保留内容；不据此宣称全部错误 toast 无遮挡（#137） |
| [integrated-thread-narrow-web](integrated/integrated-thread-narrow-web.webp) | 390×844 Web：输入／选区／Send 完整，无 toast 遮挡（#140） |
| [integrated-plugins-return](integrated/integrated-plugins-return.webp) | GitHub 详情返回后搜索词保留（#163） |
| [integrated-artifact-library-error](integrated/integrated-artifact-library-error.webp) | 旧列表保留；局部 Retry 位于折叠 toast 栈后排，展开交互未验收（#173） |
| [integrated-markdown-background-error](integrated/integrated-markdown-background-error.webp) | 正文／选区／scrollTop=650 保留；toast 栈与 composer 局部重叠，交互待验收（#190） |
| [integrated-html-background-error](integrated/integrated-html-background-error.webp) | 同一 iframe 保留；折叠 toast 栈交互待验收（#205） |
| [integrated-group-pending-and-draft](integrated/integrated-group-pending-and-draft.webp) | 较早历史与未发草稿选区；失败 pending 在 DOM 底部、未入画（#228） |
| [integrated-group-access-refused](integrated/integrated-group-access-refused.webp) | 403 后历史隐藏、输入禁用（#241） |
| [integrated-group-recovered](integrated/integrated-group-recovered.webp) | 成功授权读取恢复；实际可见 Not sent／Retry 与保留草稿（#250） |
| [integrated-explicit-update-required](integrated/integrated-explicit-update-required.webp) | removed-action 显式更新对话框；尚未自动重载（#262） |
| [integrated-explicit-update-restored](integrated/integrated-explicit-update-restored.webp) | 主动 Refresh 后 Ada 草稿恢复（#269） |
| [integrated-workspace-isolation](integrated/integrated-workspace-isolation.webp) | 备用工作区无原 Medium／APP-1／草稿（#279） |
| [integrated-workspace-return-draft](integrated/integrated-workspace-return-draft.webp) | 返回原工作区后任务评论草稿恢复（#288） |
| [integrated-signout-cleared](integrated/integrated-signout-cleared.webp) | 真实 Sign out 后登录页；键数量清理另见 DOM 观测（#295） |


## 最终候选当前验证状态

本节保留主批次候选 **156b** 及历史 **5a** 整合证据；新增 **6b4a3eb／#1637** 的当前状态见上文“第 18／19 项组合候选与验证边界”及[组合候选 JSON](followup-1637-candidate.json)，不混用检查结果。

[构建与内容绑定证据](156b-build-evidence.json)：完整 `pnpm typecheck` exit 0（39.67 秒）；`pnpm build:app` exit 0（137.27 秒）。实际 build revision 为 `156b6a2779d1ee71161b99ab47b3484e2a8b5704`，renderer build 为 `a60d2a8a19f33b7588ea5f4572a2b4f2c212b6a4a66843fb0375ddb5d9eb60ac`。166 个官方 overlay 源码、资产和文本 blob 均匹配固定 `2cbb930e409ccc247f7692abc9e2dd1152a571fe` 版本；10 个文档 PNG 不参与构建。

### 最终 CI 事实与适用范围

**审核时间：2026-11-07 07:01:03.187 UTC。** [机器可读审核记录](156b-ci-review.json)中的全部检查 head SHA 均为 `156b6a2779d1ee71161b99ab47b3484e2a8b5704`；30 项检查中 **23 success、7 skipped**，没有 failure、cancelled、queued 或 in-progress。7 个工作流均已完成并返回 success，跳过的 job 仍按 skipped 记录。

| 工作流 | 最终结论 | 实际证明范围 |
| --- | --- | --- |
| [CI](https://github.com/alexj11324/Mikka/actions/runs/42347352032) | success | Source、Core／Integration、Daemon、数据库分片及严格 UI policy 等检查；OIDC job 按路径规则 skipped。 |
| [Read cache API acceptance](https://github.com/alexj11324/Mikka/actions/runs/42347352010) | success | 既有真实 API／CLI 验收；不替代本地人工 UI。 |
| [Desktop shell](https://github.com/alexj11324/Mikka/actions/runs/42347352004) | success | [Apple Silicon packaged acceptance job](https://github.com/alexj11324/Mikka/actions/runs/42347352004/job/128329093859)于 06:52:25 UTC 完成；真实原生打包验收、三个独立 packaged process 的 Keychain 加密、包完整性和证据审计步骤均 success。 |
| [Analytics SSR](https://github.com/alexj11324/Mikka/actions/runs/42347352037) | success | Analytics SSR 的既有检查。 |
| [E2B subscription custody](https://github.com/alexj11324/Mikka/actions/runs/42347352051) | success | 既有 custody 检查。 |
| [E2B additive runtime release](https://github.com/alexj11324/Mikka/actions/runs/42347351973) | success | 本次 test job success，发布相关 6 个 job skipped；不能据此声称已发布新运行时。 |
| [Browser gate](https://github.com/alexj11324/Mikka/actions/runs/42347352027) | success | 占位检查，不是实际浏览器验收。 |

CI 中名为 `Production build and browser interactions` 的 job 是数据库分片汇总门禁，与 Browser gate 一样，均不作为本次实际 UI 证明。Desktop 原生打包验收的成功也不能改写为执行者在本地手动检查了原生桌面或 iOS。

这些检查关联候选 head；已核实 CI 实际检出的 PR 合成合并版本为 `873aaf4b3d1da4a1f78f1d29ba6828c4f143084f`，基于 main `c31ac8cd8824ea4d44d23ba548ef67bd139771bb` 与候选 `156b6a27`。审核时 main 已前移到 `ad5e5db5ed5547ea19644ce2381992d8d1583eb9`（[#1620](https://github.com/alexj11324/Mikka/pull/1620)）；新增提交没有与候选重叠的文件，静态审查未发现 UI、scope、导航或 read-cache 语义交互。随后已在本地整合该 main 与候选、完成下述构建与运行绑定；**不将旧 CI 的结论改标到本地整合提交，也不将本地整合提交称为最终 GitHub merge**。后续已完成 [main `93724cb9` 复核](final-main-93724.json)、[主批次实际 merge 回读](batch-merge-verification.json)和[#1626 后续 merge 回读](followup-merge-verification.json)，没有将旧 CI 或手动运行改标为新 SHA。

### 本地整合构建与运行绑定

[integration-build-evidence.json](integration-build-evidence.json)和[integration-runtime-binding.json](integration-runtime-binding.json)记录以下实际结果：

| 项目 | 已确认值 |
| --- | --- |
| 本地整合提交 | `5a752a50eb74c22681cd7dd8511ff6d2e58fc46f` |
| 两个 parent | main `ad5e5db5ed5547ea19644ce2381992d8d1583eb9`；候选 `156b6a2779d1ee71161b99ab47b3484e2a8b5704` |
| 源码树 | `977111e65ae6bc8c15b88e01810f2f143512c4dd` |
| 官方 overlay | `ac5980696802f188a81124a8a3f2513be2d14e9e` |
| Renderer build | `074aadefa5f4b52e647c5e12ffe816c6b1d5cd3873c7481826295b8b529118fb` |
| 生产模式构建 | `pnpm build:app`，exit 0，128.36 秒；Node v24.22.1，Nitro `node-server` |
| 实际服务绑定 | 07:19:14.159 UTC，`http://localhost:3110`；source、compiledBuild、servedBuild 均为上述 `5a752a50`，renderer／overlay 均一致 |
| 隔离数据库 | `mikka_issue1603_final4_e2e`，与 `156b` API 重跑的 `final3` 分开 |
| 手动 UI 总结与清理 | [观测摘要](integration-observations.json)：296 条记录、23 张截图；所列路径复验完成，#296 实际 close／fixture 清理／租约释放；当次误分类已在后续 #1626 修复；toast 交互验收待完成 |

新 overlay 的 170 个构建相关官方 tracked blob 均匹配，缺失构建输入为 0、blob 不匹配为 0；10 张文档 PNG 排除在构建输入外。依赖目录沿用已安装副本，未对安装后的依赖字节另行证明。上述事实只确认本地实际运行的组合；GitHub 已合并的结论来自独立 merge 回执，生产部署仍待验证。

### 历史本地运行边界与待完成生产验收

[本地 API 首轮失败](156b-local-api-attempt-1.json)与[后续 `156b` API 成功重跑](156b-api-evidence.json)分别保留。临时传输中已确认的官方 WSS 五分钟会话续接缺口已处理，成功重跑保持同一进程、同一 PostgreSQL 连接且不重放 stdin；旧失败日志没有保留 `1008` close code，因此仍不能断言这就是首轮 PG 连接中断的已证实根因。

**历史 5a 手动 UI 的所列操作与清理已完成；前 17 项已合并，第 18／19 项已完成本地最小修复并进入 draft #1637。默认 toast 栈的交互证据、新组合 6b4a3eb 的精确 CI／构建 UI、merge／最终部署及指定 SMOKE 生产验收仍 PENDING。** 已复现问题、具体根因与修复见[问题登记](defect-register.md)；在全部要求完成前不宣告 issue #1603 关闭。


## 附加机器可读审计

[合并前 GitHub 门禁快照](final-github-gate.json)记录 2026-11-07 07:43 UTC 复核的候选 CI、main `4f0f68e9` 的 CI／部署／迁移步骤，以及该 main 与候选的无冲突预测树；此后主干变化见 [final-main-93724.json](final-main-93724.json)，主批次实际合并见 [batch-merge-verification.json](batch-merge-verification.json)，第 17 项本地修复／CI／最终合并分别见 [switcher-followup-evidence.json](switcher-followup-evidence.json)、[switcher-ci-review.json](switcher-ci-review.json) 与 [followup-merge-verification.json](followup-merge-verification.json)。[integration-runtime-cleanup.json](integration-runtime-cleanup.json)独立记录最终环境回收，[toast-source-review.json](toast-source-review.json)保留早期 toast 静态复核与动态红灯。第 18 项后续修复见 [toast-fix-evidence.json](toast-fix-evidence.json)，第 19 项见 [hosted-provider-review.json](hosted-provider-review.json)，新 main 增量见 [main-1ed-review.json](main-1ed-review.json)，组合 #1637 的 head／tree／待办见 [followup-1637-candidate.json](followup-1637-candidate.json)。每份快照保持自己的版本与观察时间，不把历史报告的“当时待完成”状态当成当前结论。

[最终截图校验清单](integration-screenshots.json)列出 23 张 PNG 与无损 WebP 的哈希、尺寸、Git blob SHA 和逐像素一致性；原始截图没有经生成式修改。


## 主批次 merge 与后续修复回执（2026-11-07）

主批次 [#1619](https://github.com/alexj11324/Mikka/pull/1619) 已由owner以merge commit合并：`efb95d951ddbeca1af04bc80d011ccbc2a9f0188`；实际tree `fd7fb13f41c5a87df865f539d498b32e3a4fb83b` 与预先预测一致。原#1607/#1611均已merged，原head仍是实际merge祖先，见[读回回执](batch-merge-verification.json)。[最新主干增量审计](final-main-93724.json)明确区分新MCP通知/后台执行路径和本批UI证据，不把截图改标为新后端路径已验收。

[最终运行清理与停机](integration-runtime-cleanup.json)记录实际driver exit0、lease released、53条业务/受管声明cleaned；保留2个可复用测试身份和1个已轮换/过期session，其active计数0。应用连接与孤儿relay均0。Docker于08:00:06 UTC实测stopped；controller/broker均已退出。旧失败尝试保持真实quarantine记录。

第17项switcher错误分类已实现为独立 [#1626](https://github.com/alexj11324/Mikka/pull/1626)，head `6ccb50d7aad25eef0275af76fd8f137e9eb3faed`，parent为实际efb merge；仅2文件。既有settings-backend入口32/34红→34/34绿，完整typecheck、lint和独立review通过，见[后续修复证据](switcher-followup-evidence.json)。随后 4 项 required CI 全部成功，已于 08:13:42 UTC merge 为 `26ef4de1`，实际树与 CI 候选树一致，见[合并回读](followup-merge-verification.json)；历史发布亦已核实。本地原图仍绑定 5a/ac598，不补写成该 SHA 新 UI 运行。

第 18／19 项当前在 draft #1637（6b4a3eb）；本地修复与红绿已完成，精确候选 CI、新 UI、merge／最终部署及指定 SMOKE 账号生产验收仍 PENDING。错误 toast 栈的实际 hover／键盘交互仍须实测，截图重叠不能独自证明交互死锁。
