# Capy 桌面端 0.8.0 的首次引导，与 Mikka 的对照

日期：2026-11-15。读者是决定 Mikka 首次引导要不要改成 Capy 那样的人。读完可以判断：Capy 的引导分几段、每段问什么、长什么样，以及换到 Mikka 要动哪里、要先定什么。本文不是决定，不改 `docs/design/decisions/`。

## 看过什么

- 安装包：`https://capy.ai/download/mac/arm64` 跳到 `https://downloads.capy.ai/stable/Capy-0.8.0-arm64.dmg`（166 876 347 字节）。上一份研究看的是 0.7.2（[2026-11-10-capy-desktop-gap](2026-11-10-capy-desktop-gap.md)）。
- 读的文件：`Contents/Resources/renderer/assets/onboarding-DQUpYdYX.js`（引导本体，格式化后约 7 800 行，源路径写在埋点名里，如 `features/onboarding/onboarding-shell.tsx`、`recommended-step.tsx`、`github-step.tsx`、`plan-step.tsx`、`no-membership-page.tsx`）、`onboarding-Db1_gQwH.js`（引导清单的 API）、`setup-guide-DJt6rYco.js` 和 `route-CpcCxFyO.js` 里的应用内引导清单。
- 没有启动这个 arm64 应用，也没有登录 Capy 账号。下面的界面描述来自组件代码和文案，不是截图。

## Capy 的引导分两段

### 第一段：一张卡片里走完的设置

整屏是空白底色，正中一张卡片。卡片之外只有：左上 Capy 字标，右上外观菜单和「Log out」，卡片下方一个小药丸里是步骤圆点（当前步实心，走过的变浅，`aria-label` 是「Step 2 of 5」）。

卡片本身：

- 宽 `max-w-120`（30rem）；只有最后的「Pick a plan」放宽到 `max-w-4xl`，三栏并排。
- 每一步有一张像素风水豚插画，从卡片上沿左侧探出半个身子（`-top-10`，高 80px）：`peer`、`sit`、`sail`、`build`、`gift`、`bite`。
- 每一步结构一样：标题（一句问题或动作）、一行副标题、内容、底部按钮行。底部左边「Back」（ghost），右边主按钮「Continue ⏎」，可跳过的步骤在主按钮左边多一个「Skip」。回车键按主按钮。
- 换步时卡片不重建，高度和裁切区域补间过去（`clipPath inset(...)`），内容淡入，首次出现从下方 8px、0.96 倍弹到位，约 260ms；系统减少动态效果时只淡入淡出。
- 进度存在服务端（`progress.step`），中途关掉再打开回到同一步。

步骤按身份分三条路：

| 路径 | 步骤 |
| --- | --- |
| 自己新建、个人用 | Workspace → Profile → Subscription → GitHub → Recommended →（Plan） |
| 自己新建、团队用 | 同上，Workspace 多一页共享默认值 |
| 被邀请加入 | Join → Subscription → Recommended |

每一步问什么：

| 步骤 | 标题 / 副标题 | 内容 |
| --- | --- | --- |
| Workspace | Who is this workspace for? / You can invite people later either way | 两个选项行：Just me（Your repos, your plan）、My team（Shared threads and reviews），加工作区名字。选团队时下一页「How {name} shares work」：新工作默认谁能看（Everyone / People you choose），是否允许私有工作（Allow private work / Keep it shared） |
| Join（被邀请的人） | Join an organization / Your team is already on Capy | 列出邀请和同邮箱域可加入的组织，「{inviter} invited you」；没有时提示找管理员或「Create new org」 |
| Profile | What should we call you? | 名字和头像；团队路径同页还有组织头像和组织名 |
| Subscription | Bring a model subscription / Capy runs on plans you already pay for | Claude、ChatGPT、GitHub Copilot、SuperGrok 四行。桌面端会探测这台电脑：已登录的标「Detected」，写「Claude Max signed in on this Mac」；用的是 API key 时写明不算订阅；没装 Claude Code 时给安装命令。底部说明不绑订阅也能用 Capy 的额度。可 Skip |
| GitHub | Connect GitHub / Capy works in the repositories you pick | 三条说明（只碰你选的仓库；改动以 PR 形式回来；机器上没有 token），然后「Sign in with GitHub」装 GitHub App、选仓库，已装过的直接显示「Capy can reach N repositories」。可 Skip |
| Recommended | A few things worth turning on / All optional, and all in Settings later | 一列设置行，每行一个图标、名字、一句说明和右侧状态（Set up / Connect / Connected / Invite / Invited / Off）。第一行「Code review」带「Recommended」标签。其余：Slack、Linear、导入 Claude Code 与 Codex 历史（只在桌面端）、邀请队友、桌面端（桌面上是「Move threads between this Mac and the cloud」「Keep working when this Mac sleeps」两个开关，网页上是下载）、主题（模式、配色、背景图）。点一行在同一张卡片里推进一个子页，做完回到列表，状态就地变 |
| Plan | Pick a plan | 三栏套餐，列出包含的能力（Cloud machines、Code review、Hosted models）。有邀请码或促销时显示「You're claiming …」。底部「Skip for now」，提示「Pick a plan anytime in Settings → Billing」 |

可以注意的几处做法：

- 必填只有工作区和名字。其余每一步都能 Skip，Recommended 一页把所有「之后也能在设置里做」的东西收成一张清单，而不是各占一步。
- 子页用的是设置页里同一套组件和接口，失败时写「Could not save …, finish in Settings → …」，指回设置里的位置。
- 被邀请的人跳过建工作区、Profile 和 GitHub，只确认订阅和推荐项。

### 第二段：进应用之后的引导清单

引导结束后，应用里有一份按组织保存的清单（`/orgs/:orgId/onboarding`，每项有 `completed`、`skipped`，整份可 `dismiss` / `restore`）：

| 项 | 标签 | 说明 |
| --- | --- | --- |
| `connect-github` | Connect GitHub | Install the Capy app on the repos you want Capy to work in |
| `ship-pr` | Ship your first PR | Ask for a small change and Capy opens the pull request |
| `run-review` | Run a review | 打开任意 PR，从那里开始第一次 review |
| `install-desktop` | Desktop app | 装桌面端 |
| `set-up-environment` | Set up environment | Capy writes your setup scripts so new threads start ready to run |
| `connect-slack` | Connect Slack or Linear | Start threads from Slack messages or Linear issues |
| `invite-teammate` | Invite teammates | Invite your team by email |

每项有明暗两张配图。点一项不会打开说明页，而是在真实界面上打一个聚光圈（`setup-guide-spotlight`、`setup-guide-halo`）指向要点的控件，旁边一句话，例如「Describe a small change / Send it to start setup」「Open any pull request / Start your first review here」，可以「Hide guide」。被邀请的人看到的是个人版本：「Sign in with GitHub」「Link your Slack account」，让自己发起的工作算在自己名下。

## Mikka 现在是什么

- 官方构建（本仓库加私有 UI）用的是 affectUI 的 Onboarding 块（决定 2026-11-09，原样使用）：左边一栏问候语和四个步骤，右边一次一步。四步是：工作区名字和地址 → 连接（Claude / ChatGPT 订阅、云电脑的 E2B Key、应用）→ 邀请 → 第一个 Bot 的名字和外观。结束页列出跳过的项，按钮进入 Bot 的对话。
- 进度只存在 `sessionStorage`，换设备或关掉标签就从头开始；完成记录在点结束按钮时写进 `user_onboarding`。
- [onboarding.md](../design/onboarding.md) 描述的还是 2026-10-30 的对话式引导（Bot 一句句说、背景光加深），和现在上线的四步不是一回事。
- 进应用之后没有引导清单。

## 差别

按用户感觉得到的排：

1. **形状。** Capy 是空白底上一张窄卡片，圆点在卡片下面，一步一屏；Mikka 是左右两栏，左栏常驻步骤列表。
2. **必填和可选的分法。** Capy 只强制工作区和名字，可选项收在一张 Recommended 清单里，点开就地做；Mikka 的「连接」一步里塞了订阅、E2B Key 和应用三件事，邀请又单独一步。
3. **被邀请的人。** Capy 走短路径（加入 → 订阅 → 推荐）；Mikka 的引导没有区分被邀请的人，他们也从「工作区名字」开始走同一套四步。
4. **本机探测。** Capy 桌面端会读这台电脑上 Claude Code / Codex 的登录状态，直接标「Detected」；Mikka 的订阅行要人自己去登录。
5. **进度。** Capy 存服务端、可续；Mikka 存会话、不可续。
6. **引导之后。** Capy 有一份可跳过、可隐藏、会在真实界面上指位置的清单；Mikka 结束页之后就没有了。
7. **人物。** Capy 用水豚插画当每一步的门面；Mikka 已经有 Bot 本身（bloub 头像、16 种形状、12 种颜色），对应的位置可以放这一步要建或用到的 Bot。

## 换成 Capy 那样，要先定什么

1. **affectUI 的 Onboarding 块怎么办。** 它按「原样使用，只换数据」接进来。改成居中卡片、圆点、探出的插画，就不是换数据了。两条路：
   - 请 Alex 批一个例外，像 2026-11-15-1111 新建任务那样，记清楚保留什么（块的头尾、按钮、动效）、改了什么（主体改成单栏卡片）。
   - 或者不用这个块，按 BoardUI 规则在 Mikka 自己的界面里写这张卡片（卡片、按钮、设置行、圆点都已有 BoardUI 组件）。affectUI 的块留在模板库里。
2. **Mikka 的必填是什么。** 对照 Capy 的「Workspace + Profile」，Mikka 至少要工作区。第一个 Bot 现在是最后一步、不能跳；要不要也挪进可选清单，或者保留为必填，要定。
3. **Mikka 的「GitHub」是哪一步。** Capy 的核心资源是仓库；Mikka 的核心资源是 Bot 在哪台机器上跑（这台电脑 / 云电脑 E2B / 其他电脑）和连了哪些应用。两者选一个当独立的一步，其余进 Recommended。
4. **套餐页。** Mikka 的计费是余额、免费额度和充值（设置 › 账单），没有套餐可选，可以先不要这一步。

## 一种对应方式（供讨论）

| Capy | Mikka |
| --- | --- |
| Workspace（个人 / 团队、名字） | 工作区：个人还是团队，名字和地址（现在的第 1 步） |
| Join | 被邀请的人：确认加入哪个工作区，跳过建工作区 |
| Profile | 你的名字和头像（Settings › 账户 同一组字段） |
| Subscription | 绑定 Claude / ChatGPT 订阅（Settings › 模型订阅 的行原样搬入）；桌面端探测本机 Claude Code / Codex 登录 |
| GitHub | 第一个 Bot：名字和外观（必填与否待定） |
| Recommended | 一张清单：云电脑（E2B Key）、这台电脑（桌面端）、应用（Gmail、日历、Drive、Notion、Slack）、Linear、导入 Claude Code / Codex 历史（桌面端，对应上一份研究的缺口 3）、邀请成员、外观 |
| Plan | 暂不做 |
| 应用内清单 | 交第一个任务、连一个应用、开云电脑或连这台电脑、邀请成员；每项指向真实界面上的控件，可跳过、可隐藏，按工作区保存 |

进度改存服务端（`user_onboarding` 加当前步骤），这样刷新、换设备都能续上。
