# 模型网关、来源标注、$20 套餐和首次引导：对齐 Capy 的方案

日期：2026-11-15。读者是 Alex。读完可以决定：用哪家网关、模型目录从哪来、去掉「Mikka 默认」之后谁付钱、$20 套餐里放什么、引导四步各问什么。本文是方案，不是决定；确认后拆成决定文件和 PR。

依据：Capy 0.8.0 安装包（渲染进程里的模型表、连接设置、套餐页）、docs.capy.ai、capy.ai/pricing；Vercel 和 Cloudflare 的网关文档；Mikka 现在的代码。Capy 的细节见 [2026-11-15-capy-onboarding](2026-11-15-capy-onboarding.md)。

## 1. Capy 怎么做的

### 模型从哪来、怎么统一

- 模型目录写死在前端包里，62 个，ID 一律是 `厂商/模型`（`anthropic/claude-opus-5-5`、`deepseek/deepseek-v4-pro`）。每个模型带厂商、上下文、每百万 token 的输入 / 输出 / 缓存价、推理档位、能不能开 Fast、哪些订阅能跑它（`seats`）、能不能用自己的 key。
- 「统一」靠的就是这个 ID：不管请求最后走订阅、自己的 key、用户自己的网关，还是 Capy 额度，选的都是同一个 `厂商/模型`。
- 自己托管的模型走哪个上游，客户端看不出来。包里出现的 Vercel AI Gateway、OpenRouter、Cloudflare AI Gateway 地址，都是给用户 BYOK 填的。

### 来源有哪几种、谁先谁后

| 来源 | 怎么连 |
| --- | --- |
| 订阅 | Claude（本机 `claude setup-token` 粘贴）、ChatGPT / Codex、GitHub Copilot、SuperGrok（设备码）。只挂个人名下，同一家可以连多个账号 |
| 网关 | 用户自己的 Vercel AI Gateway、OpenRouter、Cloudflare AI Gateway、Bedrock、Fireworks、Together、DeepInfra 等 |
| Coding plan | Kimi Code、GLM Coding Plan、OpenCode Go 等 |
| API key | Anthropic、OpenAI、xAI、Google、Meta。key 自动覆盖这家以后出的新模型 |
| 自定义端点 | 任何 OpenAI 兼容或 Anthropic messages 协议，模型手动加 |

- 连上之后先「Check access」，列出这个连接实际能跑哪些模型，可以去掉其中几个。
- 顺序：自己的连接（可拖动排序）→ 组织的连接 → Capy 额度。
- 一个来源用完时可以选 Ask me、Ask before Capy credits（默认）或 Keep going。换来源时线程里贴一句，例如「Codex is used up until 11:08 PM. Running on OpenAI team key.」

### 图标和来源说明

- **模型图标**：按模型 ID 的厂商前缀查表。`deepseek/…` 永远显示 DeepSeek 的标，不管实际走哪条路。表里约 40 个品牌，每个都有单色和彩色两版；表里没有的显示首字母方块。
- **来源小标**：叠在模型图标旁边。订阅显示订阅服务的标，API key 显示一把钥匙，Capy 额度不加标。
- **来源说明**的原句：「Runs on your Codex subscription」「Runs on OpenAI team key」「Runs on Capy credits, not your subscription」「On your keys, not charged」，以及失败时的「Out of usage until …」「Reconnect needed」「The provider rejected this key」。

### 加不加价

- 模型按各家原价收。能对上的几项和 Anthropic 官方价一致：Opus 4.5 $5/$25，Sonnet 4.6 $3/$15，Haiku 4.5 $1/$5（每百万 token）。
- 但有一笔团队费：组织里有第二个人之后，所有 token 每百万收 $0.20，订阅和 BYOK 跑的也收（用量接口里的 `standaloneTokenFeeDollars`）。公开文档只写「no markup」。

### 价格

| 套餐 | 月付 | 每月额度 | 云机器 |
| --- | --- | --- | --- |
| Free | $0 | 无，可以充值 | 只能用自己的电脑；充值后按 Lite 的上限 |
| Lite | $20（年付 $16） | $20 | 并发内存合计 128 GB，单台最大 4 CPU / 16 GB |
| Pro | $100（年付 $80） | $105 | 512 GB，单台最大 8 CPU / 32 GB |
| Max | $200–$1,000 | 价格的 110% | 1 TB，单台最大 16 CPU / 64 GB |

- 所有套餐都有：不限成员、自带订阅和 key（免费版也可以）、Slack / Linear / GitHub、API、审计日志。
- 额度用来付这些：模型 token（按原价）、云机器时长（Large $0.40/小时）、生成图片、代码 review。额度不结转到下个月。
- 充值最低 $5。Lite 首周 $1，要验证过的银行卡，每张卡、每个组织各一次。

## 2. Mikka 现在是什么

- **已经有的**：
  - Vercel AI Gateway（`lib/model-admission/contract.ts`、`lib/ai-gateway-auth.ts`），按网关回报的实际成本扣点，不加价（`lib/abuse/policy.ts`，100 点 = $1）。
  - 订阅：Claude / ChatGPT，用 CLIProxyAPI worker 接 OAuth。
  - API key：Anthropic / OpenAI / DeepSeek / Kimi 和自定义端点，加密存储。
  - 「优先使用的模型」排序，用完换下一个时有提示。
  - 点数账本，Stripe 充值 $10 / $25 / $50，`workspace_billing` 里有 pro 套餐。
- **和 Capy 不一样的**：
  - 没有统一的模型目录。模型从三处拼起来：订阅回报的、key 回报的，再加一个「Mikka 默认」。
  - 「Mikka 默认」是一个写死的模型（`COORDINATOR_MODEL = deepseek/deepseek-v4.1-flash`），先走 ZeroCat，失败再走 Vercel 或 Workers AI。
  - 选择器只认 Claude 和 OpenAI 两个图标，DeepSeek 等一律显示芯片图标。
  - 线程（Claude Code / Codex CLI）只能用订阅或 key，不能用 Mikka 额度。

## 3. 方案

### 3.1 网关：用 Vercel AI Gateway

| | Vercel AI Gateway | Cloudflare AI Gateway | OpenRouter |
| --- | --- | --- | --- |
| token 加价 | 0，按厂商原价 | 0 | 0 |
| 买额度的手续费 | 无（只有支付渠道费） | 5% | 约 5.5% |
| 模型数 | 507（其中语言模型 322），公开接口 `GET https://ai-gateway.vercel.sh/v1/models`，带价格、厂商、上下文、推理参数 | 少，第三方只有 OpenAI、Anthropic、Google 等几家 | 多 |
| BYOK | 可以每次请求带 key（`providerOptions.gateway.byok`），不收费 | 存储的 key | 可以 |
| 协议 | AI SDK、OpenAI chat / responses、Anthropic messages | OpenAI 兼容 | OpenAI 兼容，另有给 Claude Code 用的 Anthropic 兼容入口 |
| Mikka 现状 | 已接入，已按它回报的成本扣点 | 只用了 Workers AI | 没有 |

结论：用 Vercel。

- 它同时提供 Anthropic messages 和 OpenAI responses 协议，而且已经接进 Mikka、按它回报的成本扣点。所以线程里的 Claude Code（`ANTHROPIC_BASE_URL`）和 Codex 也能走它，用 Mikka 额度跑任何模型。
- Cloudflare 的 5% 手续费和 OpenRouter 的约 5.5% 都会变成我们的成本。
- 注意：Vercel 的 BYOK 要求我们自己的网关账户里有余额。key 失败时它会回落到 Vercel 自己的 key 并扣我们的额度，所以 BYOK 请求要指定 `only` 并关掉回落，让失败直接报给用户。

### 3.2 模型目录：网关目录 + 一份精选

- 服务端每天拉一次 `/v1/models`，只保留 `type=language` 且带 `tool-use` 的模型，存成 Mikka 的目录。ID 沿用网关的 `厂商/模型`，订阅和 key 的模型也映射到同一个 ID。
- 选择器默认展示一份精选（约 40 个，和 Capy 的 62 个同档），按厂商分组，加收藏和搜索；搜索覆盖网关上全部语言模型。
- 每个模型显示：图标、名字、上下文、每百万 token 价格、推理档位，以及当前会走哪个来源。

### 3.3 来源和顺序

一个模型能被哪些来源跑：

- Claude 订阅 → `anthropic/*`
- ChatGPT 订阅 → OpenAI 的 Codex 系列
- 某家的 API key → 这家的全部模型
- 自定义端点 → 手动加的那几个
- Mikka 额度 → 网关上的全部模型

顺序沿用现有的「优先使用的模型」排序，改成和 Capy 一样：自己的连接 → 工作区共享的连接 → Mikka 额度。用完时的三档行为照搬，默认「用 Mikka 额度前先问我」。

### 3.4 去掉「Mikka 默认」

- 选择器里不再有「Mikka 默认」这一项。模型由人自己选：绑了订阅就能选订阅里的模型，填了 key 就能选那家的模型，有额度就能选网关上的任何模型。
- 没有工作区级的默认模型。引导第 2 步让人选一个，之后建的 Bot 都用它，每个 Bot 可以改。
- 后台杂活（短标题、记忆整理、动作标题、决策模型）还需要一个模型。它们保留一个内部模型，由 Mikka 付钱，界面上不出现。ZeroCat 和 Workers AI 只留给这些杂活，或者干脆一起删掉。
- 免费试用的 20 条消息原来跑在很便宜的 deepseek-flash 上。去掉默认以后，试用要改成按金额算（现在验证银行卡给 $1），否则有人会用 Opus 把它很快烧完。

### 3.5 图标和来源说明

- **模型图标**：按 ID 的厂商前缀（网关目录里的 `owned_by`）查表。用 `@lobehub/icons`（MIT 许可，覆盖 DeepSeek、Qwen、Kimi、智谱、MiniMax、xAI、Mistral 等），找不到的显示首字母方块。这只是 Mikka 自己界面里的图标；付费块里的图标不换。
- **来源小标**：订阅显示 Claude / ChatGPT 的标，API key 显示钥匙，Mikka 额度不加标。
- **说明文案**（中文为准，进 `messages/*.json`）：

| 情况 | 中文 | English |
| --- | --- | --- |
| 订阅 | 用你的 Claude 订阅 | Runs on your Claude subscription |
| 队友共享的订阅 | 用 {name} 共享的 ChatGPT 订阅 | Runs on {name}'s ChatGPT subscription |
| API key | 用 DeepSeek API Key（尾号 {last4}），不扣 Mikka 额度 | Runs on your DeepSeek key (…{last4}), not charged |
| Mikka 额度 | 用 Mikka 额度，按厂商原价 | Runs on Mikka credits at list price |
| 订阅用完 | Claude 订阅到 {time} 前用完了 | Claude subscription is used up until {time} |
| key 被拒 | DeepSeek 拒绝了这个 Key | DeepSeek rejected this key |
| 要重连 | 需要重新连接 | Reconnect needed |
| 换来源 | Claude 订阅到 {time} 前用完了，改用 DeepSeek API Key 继续。 | Claude is used up until {time}. Running on your DeepSeek key. |

- 这几句出现在：选择器每一行、Bot 对话和线程里每次回复下方的模型标注、设置 › 模型 的每个连接，以及用量明细里每一行。

### 3.6 $20 套餐

先只做一档，对齐 Capy Lite：

| | Free | Mikka Lite |
| --- | --- | --- |
| 价格 | $0 | $20/月，年付 $16/月 |
| 每月 Mikka 额度 | 无（验证银行卡一次性送 $1） | $20，当月有效，不结转 |
| 模型 | 自带订阅和 key；有额度时可用网关上全部模型 | 同左，额度更多 |
| 云电脑 | 自带 E2B Key | 自带 E2B Key；或用 Mikka 托管的云电脑，按小时扣额度（见待定第 1 条） |
| 线程用额度跑 Claude Code / Codex | 有额度时可以 | 可以 |
| 成员、Slack / Linear / GitHub、应用 | 不限 | 不限 |
| 充值 | 最低 $5 | 最低 $5 |
| 试用 | — | 首周 $1，要验证银行卡，每张卡、每个工作区各一次（可选） |

- 不收 Capy 那种按 token 的团队费。
- Stripe 上要新建一个 $20/月和一个 $192/年的价格，挂到现有的 `STRIPE_TEAM_RESOURCE_PRICE_ID` 那条套餐链路上（`metadata.mikka_monthly_points = 2000`）。
- 这一步需要 Stripe 账户的权限，这个会话里没有。

### 3.7 引导：affectUI 的四步，内容对齐 Capy

界面不动，只换四步的标题、内容和保存逻辑：

| affectUI 的步骤 | 对应 Capy | Mikka 问什么 |
| --- | --- | --- |
| 1（workspace） | Workspace + Profile | 这个工作区给谁用（只有我 / 我的团队）、工作区名字、你的名字 |
| 2（tools） | Subscription | 绑定订阅：Claude、ChatGPT（桌面端探测本机已登录的 Claude Code / Codex，标「已检测到」）；或填 API Key；或「先用 Mikka 额度」。下面选一个模型 |
| 3（invite） | Recommended | 一张可选清单：云电脑、这台电脑（桌面端）、应用、Slack、Linear、邀请成员（团队工作区）、导入 Claude Code / Codex 历史（桌面端）。每行写清现状（已连接 / 去设置） |
| 4（agent） | Plan | Mikka Lite 一张卡，「订阅」和「暂时跳过」 |

- 第一个 Bot 在结束时自动建好，用默认外观和第 2 步选的模型，人直接进它的对话，名字和外观之后改。
- 被邀请的人从第 2 步开始，第 1 步标为已完成。
- 进度改存服务端（`user_onboarding` 加 `step`、`status`），刷新和换设备都能续上。

## 4. 待定

1. **$20 套餐里要不要包云电脑。** Capy 的额度能付托管云机器。Mikka 现在的云电脑用的是用户自己的 E2B Key，我们的 E2B 账户是 Hobby，同时最多 20 台。要包进去，得升级 E2B 方案、按小时扣额度。
2. **试用怎么给。** 去掉「Mikka 默认」以后，「20 条免费消息」没法再控制成本。建议只保留「验证银行卡送 $1」，再加 Lite 首周 $1。
3. **第一个 Bot 自动建**，名字和外观不在引导里问。

## 5. 分几步做

1. **网关目录、图标、来源说明、去掉 Mikka 默认**（公开仓库 + 私有 UI）。不碰钱的部分，可以先做。
2. **线程用额度跑**：Claude Code 和 Codex 通过网关的 Anthropic / OpenAI 协议跑，扣 Mikka 额度。
3. **$20 套餐**：Stripe 价格、设置 › 账单、套餐卡。
4. **引导四步**和服务端进度。
