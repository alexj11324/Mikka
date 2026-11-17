# 模型走网关，不再有「Mikka 默认」；$20 Pro 和机器价格对齐 Capy

- Date: 2026-11-15
- Source: Alex, 2026-11-15, after the Capy comparison (`docs/research/2026-11-15-models-gateway-and-plan.md`): 「模型就不要用什么 Mikka 默认了，让他自己去选。绑到什么模型就可以用什么模型，绑到什么订阅也可以用什么订阅里面模型」; 「只要是上面有的模型，我们都可以用」; 图标识别和「用的是 subscription、credit 还是 API key」要讲清楚; 价格 $20/月; 「这两样问题……有答案的话，照抄他们的」; 机器价格和默认档位：「可以」.
- Status: decided. Implemented on branch `claude/sweet-lovelace-yjn2jy`: the Gateway catalogue and no 「Mikka 默认」 (rules 1, 2, 4); threads on Mikka 额度 through the model gateway (rule 3, decision 2026-11-15-2000); no trial (rule 5: no 20 free messages, card verification grants nothing, allowances granted before stay usable); Mikka Pro checkout grants 2000 plan points per paid period that expire with it, top-up from USD 5 (rule 6); Cloudflare task machines open to every workspace, prepaid from Mikka 额度 in 5-minute chunks at USD 0.025 per GiB-hour, default standard-3, `MIKKA_CLOUDFLARE_TASKS_DISABLED=1` as kill switch (rule 7); the send-time 选择套餐 dialog and 「Mikka 额度已用完」 in chats and threads (rule 8). Onboarding's four steps (工作区, 模型, 推荐, 套餐) with server-saved progress, no Bot made, landing on 新建任务 with a setup checklist (rule 8; docs/design/onboarding.md).
- Replaces: 「Mikka 默认」 as a selectable model and its trial (20 free messages, card-verification $1) from [decisions.md 2026-10-30](../decisions.md); the Coordinator default of `COORDINATOR_MODEL` for chats.

## 规则

1. **模型目录来自 Vercel AI Gateway**（`GET https://ai-gateway.vercel.sh/v1/models`），ID 一律 `厂商/模型`。订阅和 API Key 的模型映射到同一个 ID。网关按厂商原价收费，不加价；Mikka 也不加价，不收按 token 的团队费。
2. **没有「Mikka 默认」。** 人自己选模型：绑了订阅能选订阅里的模型，填了 Key 能选那家的模型，有 Mikka 额度能选网关上的任何模型。后台杂活（标题、记忆、决策）用的内部模型不出现在界面上。自托管服务器只提供管理员配置的那一个模型，没什么可选的：没选模型的对话直接用它（Mikka Cloud 仍不设默认）。
3a. **后台唤醒不分来源**（Alex，2026-11-16：「如果他有抓任务或定时任务之类的，应该是要自己去做的……不管他使用的是什么模型，不管是用 credit、额度、BYOK 还是订阅，都是这样的」）：派出任务的回报、定时任务这类后台唤醒，对订阅、自己的 Key 和 Mikka 额度一视同仁；额度不够时由这次运行自己拒绝并出提示卡。
3. **来源顺序：** 自己的连接 → Mikka 额度。同一个模型换来源不换模型，换了在线程里写一句。（2026-11-17 用户决定订阅只给主人自己用，不再共享，去掉了原来的「工作区共享的连接」这一步，见 [2026-11-17-1400](2026-11-17-1400-subscriptions-owner-only.md)。）
4. **图标和来源：** 模型图标按 ID 的厂商前缀；来源小标：订阅显示订阅服务的标，Key 显示钥匙，额度不加标；文案写明「用你的 Claude 订阅」「用 DeepSeek API Key（尾号 …），不扣 Mikka 额度」「用 Mikka 额度，按厂商原价」。
5. **没有免费试用。** 免费版用自己的电脑、自己的订阅和 Key。
6. **Mikka Pro：$20/月**（只有月付，不做年付，Alex 2026-11-15；套餐代号 `pro`，Alex 2026-11-15「用Pro」），每月 $20 Mikka 额度，当月有效不结转；额度付网关模型和 Cloudflare 编程机器。充值最低 $5。
7. **机器按内存定价，每 GB 每小时 $0.025**（同 Capy）：standard-1 $0.10、standard-2 $0.15、standard-3 $0.20、standard-4 $0.30。默认 standard-3（2 vCPU / 8 GiB）。机器时间按 5 分钟一段预付；续费晚了不停机，有 10 分钟宽限，补扣错过的几段后继续（Alex，2026-11-15：「多一点钱……没意见」）。只有额度真的付不起时才停。带屏幕的云电脑仍用用户自己的 E2B Key。
8. **第一屏和没钱时（同 Capy）：** 引导结束落在新建任务页，不建 Bot。选择器不显示余额。点发送时，这次要花 Mikka 额度而工作区既没套餐也没余额，就不发，弹出套餐窗口「选择套餐 · 套餐每月包含用量，随时可换」，成员看到「请管理员选择套餐或充值」。运行中没钱，线程里出提示卡。

## Stripe

- 正式账户「Mikka」：产品 `prod_VdReNgEMinsHXM`（Mikka Pro），月付价格 `price_1UcAlnLiChExGYzi2iAArOam`（$20/月，元数据 `mikka_billing_model=resource_v1`、`mikka_plan=pro`、`mikka_monthly_points=2000`），已通过 `lib/billing/resource-plan.ts` 的校验。生产环境把它配为 `STRIPE_TEAM_RESOURCE_PRICE_ID`。
- 不做年付（Alex，2026-11-15：「只有月付，不要搞年付」）。
