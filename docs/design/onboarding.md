# 首次引导（Onboarding，照 Comma 做）

- **Status:** draft（2026-10-30）
- **Linear / GitHub:** #129
- **参考:** Comma（AFK-surf/Comma，`clients/packages/app/src/components/onboarding`，AGPL-3.0：只借鉴流程和交互，不拷代码）
- **相关规则:** R-20（注意力）、R-40（不写解释性文案）、R-46（Coordinator 的口吻）、R-70（设置要有先例）

## 1. 用户要做的事

第一次登录 Mikka 时，一分钟内把 Mikka 用起来：知道 Coordinator 是谁、接上自己的应用和电脑，然后直接开始说第一件事。

## 2. 为什么照 Comma 做

Comma 的引导**本身就是一段对话**：它的 Router 在聊天里一句句问，用户的每个回答变成一个「自己发出的气泡」飞进对话，Router 再回一句话来承接。背景的蓝光随进度一层层加深，最后让用户真按一遍快捷键。没有表单页，也没有「下一步」按钮。

Mikka 的定位和 Comma 一样，都是一个协调者把工作拆给多个 agent 并行做。现在的 Coordinator 也是先开口（`lib/agent-welcome.ts`），所以由 Coordinator 来带引导最顺。

## 3. 在哪里出现

- 用户第一次进入工作区（建好工作区之后，或者被邀请加入之后）时出现，每人只出现一次。
- 以**蒙层**的形式盖在应用外壳上面，背后的界面做模糊处理（Comma 的 `overlay` 形态）。结束后直接落到 Coordinator 的对话里，光标停在输入框。
- 设置 › 通用里有「重新播放引导」（先例：Comma 的 Settings › Onboarding › Replay）。
- 手机端第一版不做（见 §8）。

## 4. 流程

| # | 阶段 | Coordinator 说什么 / 屏幕上有什么 | 用户的回答（气泡） | 跳过时 |
| --- | --- | --- | --- | --- |
| 0 | 开场 | 屏幕先暗下来，铺一层光；Mikka 标志（56px，`brand.md`）在中间出现并做「思考」动画；下面是「欢迎来到 Mikka」和 **开始**。 | 点「开始」，或者停留几秒后自动开始 | — |
| 1 | 打招呼（3 句） | 标志移到顶部。① 自我介绍（§6）② 不用建群聊、不用挑 agent ③「先花一分钟弄好三件事。」 | — | — |
| 2 | 连接应用 | 问一句，下面出现应用卡片：Gmail 与 Google 日历、GitHub、Slack、Notion、Linear（复用现有的 Composio 连接流程） | 「已连接 Gmail、GitHub」 | 「稍后再说」→「没关系，之后随时可以在设置里连接。」 |
| 3 | 给 Coordinator 起名、选样子 | 输入框加推荐名字，下面一排 bot 形状和颜色（复用 `bots` 表的 name / colour / shape，以及 `bot-shapes.ts`） | 「就叫你 Juno」 | 沿用默认名 Mikka |
| 4 | 连接你的电脑（可选） | 一张卡片：一条连接命令和「复制」按钮，旁边写「SSH 连接」（复用 Devices.connect） | 「已连接 alex-mbp」 | 「之后可以在设置 › 设备里连接。」 |
| 5 | 提醒 | 只在有项目被跳过时出现：「还没开的：连接应用、连接电脑。随时都能开。」 | — | — |
| 6 | 收尾 | 光退下去，出现「Juno 准备好了。」和 **开始对话** | 点「开始对话」 | — |

- 每完成一项，背景的光就深一层（Comma 的 `depth`）；跳过的项不加深。
- 用户回答之后，Coordinator 用一两句话承接，**说清楚它接下来会做什么**。例如连上 Gmail 后：「好，以后每天早上我会把要紧的邮件和这周的日程理给你。」这句话把 R-20 的注意力模型和每日简报顺带介绍了。
- 落到对话以后，Coordinator 发出现在那张欢迎卡片（「想先从哪件事开始？」加 4 个选项）。选项根据刚才连接的应用来出。
- 推送权限**不在**引导里申请（decisions 2026-10-28：等 Coordinator 第一次主动发消息之后再问）。
- 右上角一直有「跳过引导」，点了直接进入第 6 步。跳过的项照常出现在第 5 步的提醒里。

## 5. 动效与声音

- 光：深蓝色蒙层加底部涌上来的光，两角各有一团慢慢漂移的柔光，只做 opacity 和 transform 动画。有消息正在飞的时候，背景光暂停，减少重绘。
- 气泡：从（不可见的）输入框位置飞进对话。
- 系统开了「减少动态效果」时，全部改成淡入淡出。
- 声音：第一版不做（见 §8）。

## 6. 文案（中文为准，英文同步）

只用一种口吻：R-46 说的「温暖、专业、有条理的秘书」。Comma 的六种语气第一版不做。

| 位置 | 中文 | English |
| --- | --- | --- |
| 开场标题 | 欢迎来到 Mikka | Welcome to Mikka |
| 开场按钮 | 开始 | Start |
| 打招呼 ① | 我是你的 Coordinator。你只管说要做什么，我来拆成任务，交给 bot 和线程同时去做。 | I'm your Coordinator. Tell me what needs doing, and I'll split it up and hand it to bots and threads that work at the same time. |
| 打招呼 ② | 不用建群聊，也不用挑 agent，有事找我就行。需要你拍板的时候，我再来问你。 | No group chats, no picking agents. Just come to me, and I'll ask when a call is yours. |
| 打招呼 ③ | 先花一分钟，弄好三件事。 | First, three quick things. One minute. |
| 问：应用 | 先把你常用的应用接上，我就能帮你处理邮件、日程、代码和文档。 | Let's connect your apps, so I can handle your email, calendar, code and docs. |
| 答：应用 | 已连接 {apps} | Connected {apps} |
| 承接：应用 | 好，以后每天我会把 {uses} 理给你。 | Great. Each day I'll round up {uses} for you. |
| 问：起名 | 再给我起个名字吧。 | Next, give me a name. |
| 承接：起名 | {name}，好名字。从现在起，有事尽管交给我，我会盯着进度，把结果带回来。 | {name} it is. From now on, hand me anything: I'll keep an eye on it and bring you the results. |
| 问：电脑 | 最后，要不要把你的电脑接上？这样我能在上面跑 Claude Code 和 Codex。可以跳过。 | Last, connect your computer so I can run Claude Code and Codex on it. Optional. |
| 跳过 | 稍后再说 | Skip for now |
| 提醒 | 还没开的：{missing}。随时都能开。 | Still off: {missing}. Turn them on anytime. |
| 收尾标题 | {name} 准备好了。 | {name} is ready. |
| 收尾按钮 | 开始对话 | Start chatting |
| 跳过引导 | 跳过引导 | Skip setup |
| 设置行 | 重新播放引导 | Replay onboarding |

## 7. 数据

- 每个用户记一个 `onboarding_completed_at`。点「开始对话」时写入（关掉或刷新不算完成，下次进来从头开始）。
- 起名和选样子直接写进 Coordinator bot 现有的字段，不另建表。

## 8. 第一版不做

- 多种语气、开场音效、教快捷键这一步（Comma 有，Mikka 网页端没有全局快捷键）。
- 手机端引导（手机端的首次体验已经在 `mobile.md` 里定了）。
- 推送权限、个人画像（`user_facts`）的收集。

## 9. 完成标准

- `docs/review-checklist.md` 的各项检查。
- 新账号走完全程、全部跳过、只连一个应用、中途刷新，这四条路径各录一段屏。
- 浅色和深色、窄窗口、减少动态效果下都正常。
- `decisions.md` 加一行，记下 Alex 的确认。
