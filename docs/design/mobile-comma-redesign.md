# iOS 按 Comma 重做的设计记录（2026-11-06）

- **状态：** 图 01–20 已于 2026-11-06 接受
  （[决定](decisions/2026-11-06-1300-ios-comma-tabs-accepted.md)）。
  本页保留当时的调研和画面说明。后续的
  [只列任务](decisions/2026-11-07-2045-tasks-only-threads-inside.md)、
  [一个任务一段对话](decisions/2026-11-07-2300-one-conversation-per-task.md)、
  [居中标题](decisions/2026-11-08-0120-ios-header-like-comma.md)、
  [状态图标颜色](decisions/2026-11-08-0130-task-state-icon-colours.md)和
  [间距](decisions/2026-11-08-0200-mobile-spacing.md)以及
  [聊天手势与标题](decisions/2026-11-08-1430-ios-chat-gestures-and-header.md)
  取代对应旧画面。
  实现与现行规范见 [mobile.md](mobile.md) 和 [components.md](components.md)。
- **起因：** Alex 觉得抽屉版（#1408、#1446、#1453）不好看，不要抽屉，参照 Comma 的移动端重做
  （[决定 2026-11-06-1200](decisions/2026-11-06-1200-ios-drop-drawer-comma-redesign.md)）。
- **图（源）：** Figma 文件 `zPe5LKycb2XuT1ivCLRw07` 的页面
  「待 Alex 确认 · iOS 按 Comma 重做（2026-11-06）」（[打开](https://www.figma.com/design/zPe5LKycb2XuT1ivCLRw07/?node-id=1020-1346)），
  上排浅色、下排深色。系统控件全部是 **Apple 官方 Figma 库「iOS and iPadOS 27」** 的组件实例（见下面「Figma 里用的 Apple 组件」），
  颜色绑定该库的 `Color Scheme` 变量（Light / Dark 两个模式），文字用该库的文字样式（SF Pro；中文字符用 Noto Sans SC，
  因为 Figma 网页端、服务端和 Mac 都有它，三处排版一致；真机上是 PingFang SC）。
- **图（导出）：** [`mobile-comma/light/`](mobile-comma/light/) 和 [`mobile-comma/dark/`](mobile-comma/dark/)，iPhone 17 Pro
  402×874 pt（Apple 当前这套库的 iPhone 组件都是 402 宽，没有 393 版本，所以没有拉伸它们去凑 393×852），由 Figma 按 1 倍导出；
  要看细节请直接在 Figma 里放大。总览：[`overview-light.png`](mobile-comma/overview-light.png) /
  [`overview-dark.png`](mobile-comma/overview-dark.png)。
- **Comma 参照：** [AFK-surf/comma](https://github.com/AFK-surf/comma) 的原生 iOS 应用
  `clients/apps/apple/iOS`（SwiftUI + UIKit），读的是提交
  [`66ab3dc`](https://github.com/AFK-surf/comma/tree/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS)。
  只读了源码，没有运行它的任何脚本，没有复制代码、文字或图片；仓库里也没有 Comma 的截图。
- **HIG：** 以 Apple 官方 Human Interface Guidelines 为准（2026-11-06 读取 Tab bars、Search fields、Toolbars、Sheets、
  Materials、Color、Typography、Accessibility 各页）。

## 结论先说

Alex 说「Comma 的做法符合 Apple 最新的设计规范」，**大部分成立，但不是全部。** Comma 的骨架是标准的 iOS 26：系统
tab bar 浮在 Liquid Glass 上、搜索放在 tab bar 末端、导航栏按钮是玻璃圆钮、玻璃只用在控件层、Dynamic Type 全程跟随、
Reduce Motion 都有退路。有五处它故意偏离 HIG（详见下面的对照表）：

1. 把 tab bar 末端**搜索 tab 的位置**拿来放「打开 Comma 聊天」的圆钮（HIG：那个位置是给搜索的）。
2. tab **只有图标没有文字**（HIG：「Include tab labels」）。
3. **不用大标题**，所有页面标题都是 20 pt 的行内标题（HIG：「Use a large title to help people stay oriented」）。
4. 角标用**小蓝点**代替系统的红色数字 badge（HIG：badge 是红底白字，只留给关键信息）。
5. sheet 一律用**不透明底**，不用 iOS 26 部分高度 sheet 的玻璃外观。

新设计跟 Comma 的布局和手感走，这五处按 HIG 改：搜索 tab 就是搜索；tab 有文字；tab 根页面用大标题；未读数字用系统
badge；部分高度的 sheet 用系统默认外观。

## 一、Comma iOS 是怎么做的

| 方面 | Comma 的做法 | 源码 |
| --- | --- | --- |
| 导航结构 | 系统 `UITabBarController`，三个 tab：Home、Inbox、Settings（Settings 的图标是本人头像）。Inbox 旁边插了一个「搜索任务」按钮，点它在 tab 上方盖一层搜索，不改变选中的 tab。最右边是 `UISearchTab` 的独立圆钮，但点它打开的是 Comma（总调度）聊天：聊天从圆钮里放大出来，关闭时缩回圆钮。打开的任务放在底部的 dock 里（像 Telegram 小程序：最小化时是底部一条，往上拖成整页）。没有抽屉。 | [`Shell/AppTab.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Shell/AppTab.swift)、[`Shell/ShellTabBarController.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Shell/ShellTabBarController.swift)、[`Shell/AppShellView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Shell/AppShellView.swift)、[`Shell/Router/RouterZoom.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Shell/Router/RouterZoom.swift) |
| 首页 | 一行问候（早上/下午/晚上 + 名字），有简报时带小箭头打开简报；下面一排已连接应用的卡片（圆角 20）；再下面是任务列表。任务按状态筛选，筛选器是浮在 tab bar 上方 12 pt 的玻璃胶囊：选中的状态显示文字，其余只显示图标，手指可以在上面滑动连续切换。 | [`Home/HomeView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Home/HomeView.swift)、[`Home/HomeHeader.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Home/HomeHeader.swift)、[`Tasks/List/TaskStatusSwitcher.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Tasks/List/TaskStatusSwitcher.swift) |
| 列表行 | 没有分隔线、没有系统行背景；行的按压面离两侧 10 pt、圆角 10，按下即显示、抬起才执行。任务行 = 状态图标 + 最多两行标题；未读点放在图标前面。左滑是带图标和文字的胶囊动作（已读、清除、归档）。 | [`Tasks/List/TaskListRow.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Tasks/List/TaskListRow.swift)、[`Design/Lists/ListRows.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Design/Lists/ListRows.swift)、[`Inbox/InboxView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Inbox/InboxView.swift) |
| 聊天页 | 消息正文 17 pt（`.body`）；气泡圆角 20，内边距 10/13；助手气泡浅灰（#F1F1F1 / #343538），自己的是品牌蓝。输入框浮在聊天底部：左边单独一个 44 pt 的玻璃「+」，右边是逐行长高的玻璃输入框，发送按钮在框内；键盘升起时输入框展开成卡片。「+」长按/点按长出一张玻璃卡片（最近照片一排 + 选项）。右滑消息引用回复（有阻尼、到位有反馈），左边缘留给系统返回。 | [`Chat/ConversationComposer.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Chat/ConversationComposer.swift)、[`Chat/ReplySwipe.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Chat/ReplySwipe.swift)、[`Chat/Composer/AttachmentTray.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Chat/Composer/AttachmentTray.swift) |
| 任务页 | 底部 dock：最小化时是一条（关闭、标题、状态），App 收成卡片露出黑色缝隙；上拖变成整页 sheet。 | [`Tasks/Dock/TaskDockViewController.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Tasks/Dock/TaskDockViewController.swift) |
| 设置 | 一个 tab（头像）。最上面是账号行（头像、名字、邮箱 → 个人资料），然后工作区（多个时进入选择页，选中即返回）、通知、标签、设备、语言、版本、退出登录。分组卡片圆角 24、行高 50、组距 8。 | [`Settings/SettingsView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Settings/SettingsView.swift)、[`Settings/Pages/WorkspacePickerView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Settings/Pages/WorkspacePickerView.swift)、[`Design/Surfaces/GroupedSurface.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Design/Surfaces/GroupedSurface.swift) |
| 搜索 | iOS 26 上搜索框和关闭按钮出现在键盘正上方（系统的搜索位置）；停顿 300 ms 后搜索；关闭后回到原来的 tab。 | [`Home/TaskSearchView.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Home/TaskSearchView.swift) |
| 字号 | 只用 Dynamic Type：`.title3` 20 semibold 做所有标题（明确不用大标题），`.body` 17、`.subheadline` 15、`.footnote` 13、`.caption` 12。 | [`Shared/Design/CommaTheme.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/Shared/Design/CommaTheme.swift)、[`Design/Bars/PageTitle.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Design/Bars/PageTitle.swift) |
| 颜色 | 自己的一套十六进制 token（品牌蓝 #205BFF / #3B7CFF，深色页面 #0F0F10），不是系统色。 | 同上 |
| 玻璃 | iOS 26 用系统 `glassEffect`（regular，可交互），之前的系统退回 `regularMaterial` + 发丝线 + 轻阴影；相邻玻璃放进 `GlassEffectContainer` 互相融合；玻璃只用在控件上（tab bar、输入框、浮动筛选器、菜单卡片）。sheet 用不透明的卡片底。 | [`Shared/Design/CommaGlass.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/Shared/Design/CommaGlass.swift)、[`Design/Surfaces/Sheet.swift`](https://github.com/AFK-surf/comma/blob/66ab3dc92475005aea9afd123df36a28e4ef86ab/clients/apps/apple/iOS/Design/Surfaces/Sheet.swift) |
| 动效 | 选择类都用临界阻尼弹簧（response 0.32，不回弹）；发送气泡位置 0.44/0.99、宽度 0.34/0.86；助手消息 160 ms 从 2 pt 下方淡入；回复线程 0.42/0.86；每个动画都有 Reduce Motion 分支（改成 0.15 s 淡入淡出）。 | `CommaTheme.swift` 的 `CommaMotion` |

## 二、和 HIG 对照

✅ 符合 · ⚠️ 部分符合 · ❌ 不符合。「Mikka 新设计」一栏说明这里怎么做。

| HIG 要求（原文出处） | Comma | Mikka 新设计 |
| --- | --- | --- |
| Tab bar 浮在内容上方、Liquid Glass 底（Tab bars › iOS） | ✅ 系统 tab bar | ✅ `NativeTabs`，系统画 |
| 「Use a tab bar to support navigation, not to provide actions」（Tab bars） | ⚠️ 搜索按钮和 Comma 圆钮都是动作（打开一层），不切换 tab | ✅ 四个 tab 都是页面；新建、筛选放在各页工具栏 |
| 「A tab bar can include a dedicated search tab at the trailing end」（Tab bars › iOS）；搜索 tab 两种样式：标准 tab 或按钮外观（Search fields › Search as a tab） | ❌ 末端位置放的是 Comma 聊天；真正的搜索按钮插在 Inbox 旁边 | ✅ 末端就是搜索 tab，用「按钮外观」：点开键盘直接升起，搜索框在键盘上方 |
| 「Include tab labels… Use single words whenever possible」（Tab bars） | ❌ 只有图标 | ✅ 对话 · 线程 · 建议 · 设置 |
| 「Prefer filled symbols」（Tab bars） | ✅ 选中时用 `-fill` | ✅ 选中用填充版 SF Symbol |
| Badge：红底白字，只留给关键信息（Tab bars） | ⚠️ 用 8 pt 小蓝点 | ✅ 「建议」有新简报时用系统 badge；不滥用 |
| 「Don’t disable or hide tab bar buttons」「Make sure the tab bar is visible…」（Tab bars） | ✅ | ⚠️ 进入聊天/线程页时 tab bar 收起（push 的详情页底部是输入框）。返回按钮保留位置感，这是 Messages 之外常见聊天应用的做法；列为待 Alex 确认的取舍 |
| 「Use a large title to help people stay oriented」（Toolbars） | ❌ 全部 20 pt 行内标题 | ✅ 四个 tab 根页和插件、工作区用大标题，滚动后收成行内标题；聊天、线程页用行内标题 |
| 标题短于 15 个字符、不用 App 名做标题（Toolbars） | ✅ | ✅ |
| 工具栏分组不超过三组；关键动作单独一组（Toolbars） | ✅ | ✅ 每个导航栏最多左右两组 |
| Liquid Glass 只用于控件/导航层，不用于内容层；少用（Materials） | ✅ | ✅ 只有 tab bar、导航栏按钮、输入框、「+」、线程状态切换器、菜单是玻璃；消息、卡片、列表都是普通背景 |
| regular 与 clear：文字多的控件用 regular（Materials） | ✅ regular | ✅ 全用 regular |
| Liquid Glass 上少用颜色；主操作把颜色放在背景（Color › Liquid Glass color） | ✅ | ✅ 只有 sheet 的确认钮是填充的强调色 |
| Sheet：单视图的 Cancel 在左上、Done 在右上；可调高度的 sheet 带 grabber；iPhone 上考虑 medium detent（Sheets） | ⚠️ 关闭叉在左；sheet 用不透明底 | ✅ 左上 ✕、右上 ✓（强调色）；新建 Bot / 群聊是 large；附件用菜单卡片不用 sheet |
| 一次只显示一个 sheet（Sheets） | ✅ | ✅ |
| Dynamic Type，可放大到 200%（Accessibility、Typography） | ✅ 全部用文本样式 | ✅ 全部用文本样式（大标题 34、正文 17、副文 15、脚注 13） |
| 对比度达到 WCAG AA，或在「增强对比度」下达到（Accessibility） | ✅ 专门调深了浅色的次要文字 | ✅ 沿用 `lib/tokens.ts`：系统色 + `accentFill` 深蓝承载白字（5.3:1） |
| 控件足够大（Accessibility） | ✅ 44 pt | ✅ 所有可点控件 ≥ 44 pt |
| Reduce Transparency / Increase Contrast 下玻璃要保持可读（Materials） | ✅ 系统玻璃自动处理 | ✅ 用系统玻璃（`expo-glass-effect`）；自绘的状态切换器在 `isLiquidGlassAvailable()` 为假时退回不透明底 |
| Reduce Motion | ✅ 每个动画都有分支 | ✅ 沿用 `lib/springs.ts` 和现有分支 |

## 三、接受后更新的导航结构

```text
NativeTabs（系统 tab bar，Liquid Glass）
├─ Bot       Stack：Bot → 聊天 / 群聊 → Bot 资料 / 任务
├─ 任务      Stack：任务 → 任务详情 → 任务的一段对话
├─ 建议      Stack：建议 → 插件 / Coordinator 聊天
├─ 设置      Stack：设置 → 个人资料 / 工作区 / 通知 / 记忆 / 插件
└─ 搜索      role="search"：Bot、群聊、任务
新建 Bot / 新建群聊：从 Bot 右上角 + 打开 formSheet
```

- 工作区只从 设置 › 工作区 切换。Bot 和任务都用 + 作为新建入口。
- 每个 tab 根页只有一处系统居中标题，按钮集中在右侧，左侧留空。tab 不显示角标。
- 列表只列任务。点任务进入详情，点 活动 中的一行进入该任务的同一段对话，滚到对应位置。
- Coordinator 和其它 Bot 使用相同入口。聊天和任务详情以 push 打开，tab bar 收起。

## 四、2026-11-06 的画面记录

以下表格保留原画面的结构和取舍；后续已替换的项目按页首决定和 §三。
文件名在 `light/` 和 `dark/` 下相同。

| # | 图 | 结构和取舍 | 对应 Comma |
| --- | --- | --- | --- |
| 01 | [对话](mobile-comma/light/01-chats.png) | 左上工作区按钮（系统文字栏按钮「Mikka ⌄」），右上新建（系统玻璃圆钮 square.and.pencil）。大标题「对话」。置顶格（Coordinator、研究员、设计师；星标是置顶，橙点是等你，蓝色数字是未读）。分区：正在工作（灰色脉动点 + 进行中）、Bot、群聊；每行头像 44、名字 17 semibold、最后一句 15、时间 13。没有分隔线，按压面离两侧 10 pt。 | Home 的列表行样式、无分隔线；问候行没有采用（R-40：不加没信息的话） |
| 02 | [长按菜单](mobile-comma/light/02-chats-longpress.png) | 系统 context menu：上面是那个聊天的实时预览，下面：标为已读、置顶、隐藏、信息、更多 › 复制 ID（与现在 `chat-menu.tsx` 一致）。 | Comma 的任务行菜单 |
| 03 | [左滑](mobile-comma/light/03-chats-swipe.png) | 左滑出两个胶囊动作：置顶（橙）、隐藏（灰），图标 + 文字。 | Inbox 的胶囊滑动动作 |
| 04 | [工作区切换](mobile-comma/light/04-workspace-menu.png) | 工作区按钮弹系统菜单：当前工作区打勾，其它一点即切；编辑顺序、工作区设置。 | Settings › Workspace 选择页（另有入口见 19） |
| 05 | [新建](mobile-comma/light/05-new-menu.png) | 新建钮弹菜单：新建 Bot、新建群聊。 | Comma 的新建入口在聊天里；Mikka 的新建对象是 Bot 和群聊，所以放在对话页 |
| 06 | [新建 Bot](mobile-comma/light/06-new-bot.png) | sheet 打开状态。左上 ✕，右上 ✓（强调色填充），标题「新建 Bot」，无副标题。大头像预览、名字、形状 6 选 1、颜色 12 选 1。 | Comma 的 sheet 关闭位置；外观按 HIG |
| 07 | [新建群聊](mobile-comma/light/07-new-group.png) | 群聊名称、选择 Bot（勾选圆圈）。 | 同上 |
| 08 | [聊天](mobile-comma/light/08-chat.png) | 系统导航栏：返回、标题（Bot 名字，点开 Bot 资料）、更多。简报是一个气泡，每项一个对象芯片（R-41）；主动消息卡片（结果和截止时间、来源、三个按钮）；我的蓝气泡；线程卡片（状态图标 + 名字 + 产出芯片，R-15/R-66）；Bot 回复下面一个复制钮。底部：独立玻璃「+」+ 玻璃输入框。一对一聊天不显示头像和名字（R-13）。 | 输入框形态、气泡尺寸、浮动输入框 |
| 09 | [消息长按](mobile-comma/light/09-chat-message-menu.png) | 背景模糊，气泡被托起；上方六个反应（一人一个，再点取消），下方：回复、复制、选择文本。 | Comma 的消息菜单；反应放法沿用 Mikka 已有决定 |
| 10 | [附件](mobile-comma/light/10-chat-attach.png) | 「+」弹出系统菜单：相机、照片、文件。替换现在的底部 sheet。 | 「+」卡片的入口位置；形态改用系统菜单（HIG：菜单优先于自画卡片） |
| 11 | [右滑引用](mobile-comma/light/11-chat-reply-swipe.png) | 气泡被拖向右边，左侧露出回复箭头；过线松手引用到输入框。左边缘仍是系统返回。 | ReplySwipe |
| 12 | [群聊](mobile-comma/light/12-group-chat.png) | 系统标题是群名。Bot 消息在左边带小头像和名字，我的在右边；`@前端` 指定谁回答。 | — |
| 13 | [线程](mobile-comma/light/13-threads.png) | 大标题「线程」，右上新线程。分段控件「线程 / 任务」；设备芯片（在线绿点）。分组：等待你、进行中、受阻、空闲、已解决（折叠，R-52）。底部浮着玻璃状态切换器：全部（文字）、等待你、进行中、已解决（图标），手指可滑动连续切换——替换现在的筛选菜单。 | 浮动状态切换器 |
| 14 | [线程页](mobile-comma/light/14-thread.png) | 行内标题：线程名 + 「Bot · 执行器 · 机器图标」。工具调用折叠成「已探索 4 次搜索」等行；产出芯片（PR、图片）；运行中时输入框的发送键变成停止键。 | 任务 dock 的内容区；外层仍是 push |
| 15 | [任务](mobile-comma/light/15-tasks.png) | 「任务」分段：进行中、待办、已完成；行 = 圆形状态 + 标题 + 「#编号 · Bot」，点开在网页打开。 | Home 的任务行 |
| 16 | [建议](mobile-comma/light/16-suggestions.png) | 大标题「建议」，右上插件钮。一排已连接应用卡片（应用、要你处理的数量）；「今天」的条目一行一个、动词开头（R-41）；已处理折叠。点条目进 Coordinator 聊天。 | Home 的应用卡片和简报 |
| 17 | [插件](mobile-comma/light/17-plugins.png) | 右上系统搜索钮、分段「应用 / 技能」、已连接（绿点）、热门。行打开网页上的连接流程（已有实现）。 | — |
| 18 | [设置](mobile-comma/light/18-settings.png) | 大标题「设置」。账号行（头像、名字、邮箱 → 个人资料）；工作区；通知、记忆、已连接的 App；外观、语言、版本；退出登录。行带彩色系统图标方块。 | Settings 页的顺序和账号行 |
| 19 | [工作区](mobile-comma/light/19-workspaces.png) | 工作区列表，当前打勾，选中即返回；右上「编辑」排序。 | WorkspacePickerView |
| 20 | [搜索](mobile-comma/light/20-search.png) | 搜索 tab 的按钮外观：键盘直接升起，搜索框和关闭钮在键盘上方；结果按 Bot、群聊、线程分组。 | TaskSearchView（范围扩大到 Bot 和群聊） |

深色版是同一套 Apple `Color Scheme` 变量切到 Dark 模式（页面纯黑、分组卡 #1C1C1E，sheet 里用 Elevated 层级），不是 Comma 的 #0F0F10。

### Figma 里用的 Apple 组件（iOS and iPadOS 27 库）

| 部分 | Apple 组件 |
| --- | --- |
| 状态栏、Home 指示条 | `Status Bar - iPhone`（iPhone 17 Pro）、`Home Indicator` |
| 导航栏 | `Toolbar - Top - iPhone`：tab 根页 `Large Title`，聊天 `Default`，线程页 `Title 2 Line`；按钮是它插槽里的 `_Buttons - 44pt`（Back / Symbol / Text / Symbol - Prominent） |
| Tab bar | `Tab Bar - iPhone`，`Tabs=5, Type=Search Role`（4 个 tab + 末端搜索圆钮） |
| 长按 | `Context Menu` + `Context Menu - Dimming Overlay`，菜单项是 `Menu Items` |
| 栏按钮菜单（工作区、新建、附件） | `Menu` + `Menu Items` |
| 左滑 | `Row with Swipe Actions` 里的 `_Swipe Actions/Symbol and Label Stacked` |
| Sheet | `Sheet - iPhone`（Detent=Large，grabber、压暗层、左 ✕ 右 ✓） |
| 表单 | `Text Field`、`Header`（Nested）、`Row`、`Row - Button`（Destructive）、`Segmented Control`（Small） |
| 卡片里的按钮 | `Button - Liquid Glass - Text`（Glass Prominent / Glass） |
| 输入框和浮动状态切换器的材质 | `Liquid Glass - Regular - Medium` |
| 搜索 | `Accessory Bar - iPhone/Search` + `Keyboard` |
| 图标 | SF Symbols（SF Pro 字体里的符号字符） |

Mikka 自己的部分是页面上「Mikka 本地组件」框里的组件：bloub 头像、对话行、置顶格、群头像、线程行、气泡、线程卡片、输入框。
它们的颜色也绑 Apple 的变量；只有「我的气泡」和发送键用 Mikka 的 `accentFill` #0068DA（白字对比度，见 `apps/mobile/lib/tokens.ts`）。

和第一版（HTML 画的）相比，用了 Apple 组件以后有几处变化：聊天页标题是系统标题，不再是自画的玻璃胶囊；「+」附件用系统菜单
（相机、照片、文件），不再是自画的玻璃卡片；搜索是系统的键盘上方搜索栏。

## 五、2026-11-06 与当时抽屉版的对照

| 当时的抽屉版 | 2026-11-06 设计 |
| --- | --- |
| 一个 Stack，装在推开式抽屉里；左上工作区按钮或右滑打开抽屉 | 系统 tab bar，四个 tab + 搜索 tab；没有抽屉，没有边缘右滑手势冲突 |
| 线程、建议、任务、插件、设置都在抽屉里 | 线程（含任务）、建议、设置各是一个 tab；插件从设置和建议进入 |
| 工作区在抽屉顶部 | 对话页左上的系统菜单 + 设置 › 工作区 |
| 搜索是对话页导航栏下的系统搜索框，只搜 Bot 和群聊 | 搜索 tab，搜 Bot、群聊、线程 |
| 对话页没有标题 | 大标题「对话」 |
| 线程筛选是右上的菜单 | 浮动玻璃状态切换器 |
| 附件是底部 sheet（相机/照片/文件三块） | 「+」弹出系统菜单（相机、照片、文件） |
| 账号在抽屉底部 | 设置 tab（头像图标）顶部的账号行 |

## 六、2026-11-06 的实现方案记录

| 部分 | 组件 |
| --- | --- |
| Tab bar | Expo Router `NativeTabs`（`expo-router/unstable-native-tabs`），`NativeTabs.Trigger` + `.Icon sf={{ default, selected }}` + `.Label` + `.Badge`；搜索 tab 是 `role="search"`。设置 tab 的头像用 `.Icon src` 渲染本人头像。`minimizeBehavior` 不开（和 Comma 一样常驻）。 |
| 每个 tab 的页面 | 各自一个 `Stack`（`app/(tabs)/(chats)/_layout.tsx` 等），根页 `headerLargeTitle: true`，`headerTransparent` + iOS 26 的 `scrollEdgeEffects`（现有 `screenOptions` 已有）。聊天、线程页 push 时用 `NativeTabs` 的 `hidden` 收起 tab bar。 |
| 导航栏按钮和菜单 | `Stack.Toolbar`（`Stack.Toolbar.Button`、`Stack.Toolbar.Menu` / `MenuAction`）：工作区菜单、新建菜单、聊天的更多。系统自动给玻璃。 |
| 搜索 | 搜索 tab 里的 `Stack.SearchBar`（`placement` 由系统放到键盘上方）；插件页同样用 `Stack.SearchBar`。 |
| 长按菜单 | 对话行沿用 `Link` + `Link.Preview` + `Link.Menu`（`chat-menu.tsx`）；消息沿用 `MessageMenu.ios.tsx`（`@expo/ui` `ContextMenu` + `ControlGroup` 放反应）。 |
| 左滑动作 | 沿用 `pin-swipe.ts` 的逻辑，动作画成胶囊。 |
| 分段控件 | `@expo/ui` `Picker`（segmented），沿用 `Segmented.ios.tsx`。 |
| 设置、工作区、新建 Bot / 群聊的表单 | `@expo/ui` `Form` / `Section` / `FieldGroup`（`components/settings.tsx` 的 `Row` 迁过去，`mobile.md` 已列为待办）。 |
| Sheet | 路由 `presentation: 'formSheet'`，`sheetAllowedDetents: [1]`、`sheetGrabberVisible`；左上 ✕ / 右上 ✓ 用 `Stack.Toolbar`。 |
| 输入框、「+」、线程状态切换器（附件用系统 `Menu`） | `expo-glass-effect` 的 `GlassView`（`isInteractive`）和 `GlassContainer` 让「+」与输入框融合；`isLiquidGlassAvailable()` 为假时退回不透明 `surface`。状态切换器放在 `NativeTabs.BottomAccessory`（iOS 26，`usePlacement()` 处理收起时的 inline 形态）。 |
| 图标 | SF Symbols（`expo-symbols`，现有 `Symbol.ios.tsx`）。 |

## 七、2026-11-06 计划保留的部分

- **聊天列表虚拟化：** `features/chat/components/chat-message-list.tsx`（`@legendapp/list`）。
- **发送动效和新消息上浮：** `lib/springs.ts`（`ENTER`、`SNAP_BACK`）及其 Reduce Motion 分支。
- **气泡手势：** `components/chat.tsx` 的 `TimedRow`（右滑引用）和 `useTimeReveal`（左滑看时间）。
- **首页行交互的后端：** `features/home/model/use-home-chats.ts`（置顶、隐藏、已读/未读、复制 ID、置顶上限）、`home-list.ts`、`pin-swipe.ts`，以及 `chat-menu.tsx` 的菜单项。
- 消息菜单 `MessageMenu.ios.tsx`、OpenUI 卡片 `components/OpenUI.tsx`、`cards.tsx`、输入框里的模型菜单 `ModelMenu.ios.tsx`、所有 `app/api/mobile/*` 接口。
- 要删的只有抽屉：`features/shell/components/app-drawer.tsx`、`drawer-content.tsx` 和 `drawerDim` / `drawerLift` / `drawer` / `drawerRow` token（#1470、Phase 5 已删）。

## 八、Alex 的原始决定（2026-11-06）

设计图 01–20 通过（[决定](decisions/2026-11-06-1300-ios-comma-tabs-accepted.md)）。

1. 四个 tab 叫「对话 · 线程 · 建议 · 设置」，最后是搜索 tab（`role="search"`）。任务是「线程」里的分段。
2. 进入聊天和线程页时收起 tab bar。
3. 不做底部任务 dock，线程页仍然 push（R-15 不变）。
4. 线程筛选用浮动状态切换器（图 13），替换右上筛选菜单。

## 没有复制 Comma 的内容

原设计 PR 只包含文档和设计图。图在 Figma 里用 Apple 官方 iOS 27 库的组件和 Mikka 自己的组件拼成，头像是 Mikka 的 bloub。没有复制 Comma（AGPL-3.0）的代码、文字、图标或截图；上面的数值和行为是读源码后的
描述，链接指向它的仓库。
