# 首次引导（Onboarding）

- **Status:** 当前实现，内容对齐 Capy（决定 [2026-11-15-1900](decisions/2026-11-15-1900-models-on-gateway-like-capy.md) 第 8 条；调研 [2026-11-15-capy-onboarding](../research/2026-11-15-capy-onboarding.md)）。官方构建用 affectUI 的 Onboarding 块，原样使用，只换数据和文字（`mikka-hosted-ui/slots/onboarding.tsx`，`patches/onboarding.patch`）。
- **历史：** 2026-10-30 的对话式引导（Bot 一句句说、背景光、建第一个 Bot）见本文件在 `caa5145c` 及以前的版本；公开构建的 `components/onboarding/onboarding.tsx` 仍是那一版，只要求能编译。

## 1. 什么时候出现

- 第一次进入工作区时，盖在应用上；每人一次。完成或「跳过引导」后在 `user_onboarding` 记一行。
- 引导走到哪一步、哪些做了或跳过，存在服务端 `user_onboarding_progress`。刷新、去设置页再回来、换一台设备，都从同一步接着走。
- 设置 › 偏好设置的「重新播放引导」清掉这两张表里这个人的记录。

## 2. 四步

| 步 | 对应 Capy | 内容 | 保存 |
| --- | --- | --- | --- |
| 1 工作区 | Workspace + Profile | 工作区名称和地址；你的名字 | `updateWorkspace`；名字走设置 › 账户的同一个保存 |
| 2 模型 | Subscription | Claude、ChatGPT 订阅行（设置 › 模型与订阅的行原样搬入）和 API Key 行（去设置添加）；下面列出能用的模型：订阅和 Key 的全部模型，加上目录里 Mikka 额度的精选模型，每行有厂商图标、来源说明和价格。必须选一个 | `chooseBotModel`：Coordinator 的模型。没有工作区默认 |
| 3 推荐 | Recommended | 可选的行：云电脑（E2B Key，当场填）、这台电脑（只在桌面端，去设置）、应用（Gmail、Google 日历、Notion、Slack，当场登录）、Linear（去设置）；团队工作区下面是邀请成员 | 各行自己的保存；邀请走 `createWorkspaceInvitation` |
| 4 套餐 | Plan | Mikka Pro · $20/月：每月 $20 Mikka 额度、Cloudflare 云端机器、网关上的全部模型。「订阅」去 Stripe；「先跳过」继续 | `startPlanCheckout` |

- 被邀请加入别人团队工作区的人从第 2 步开始，第 1 步记为已完成（Capy 的 invitee 路径）。
- 引导不建 Bot（Capy 不建 Captain）。结束页列出还没做的：交第一件事、绑订阅或 Key、开云电脑；按「开始使用」打开新建任务。

## 3. 新建任务里的设置清单

- 新建任务的输入框下面，引导之后有一份设置清单（Capy 的 setup guide）：交第一件事、绑订阅或 Key、连这台电脑（只在桌面端）、连一个应用、邀请成员（只在团队工作区）。
- 每项的状态从已有的数据读出（有没有任务、订阅或 Key、电脑、应用、第二个成员或邀请），不另存。没做的项旁边有去设置的链接。
- 全部做完，或者这个人在这个工作区点了隐藏（`setup_checklist_dismissals`），清单就不再出现。若手动隐藏，设置 › 偏好设置的「显示清单」可恢复当前工作区里本人的清单。完成项从实际数据重新读取。

## 4. 没做的

- 桌面端探测本机已登录的 Claude Code / Codex（同 Capy：`claude auth status --json`、`codex login status`，桌面桥 `device.agentLogins`），订阅行写「已检测到：这台电脑的 Claude Code 已登录 Max」。只读登录方式和套餐名，不读凭据。
- 「只有我 / 我的团队」：没有改工作区类型的写入，第 1 步不问。
- 导入 Claude Code / Codex 历史：Mikka 还没有这个功能，推荐里不列。
- 新建任务里的「新建 Bot」入口：清单里不放，侧栏照旧可以新建。
