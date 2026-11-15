# 模型请求统一经 Mikka 网关；协议转换用 LiteLLM

- Date: 2026-11-15
- Source: Alex, 2026-11-15: 「是不是走服务端计费啊，不然用超了怎么办」;「我觉得是不是网关统一起来最好」;「我就是需要支持很多杂牌啊」; chose option B (Mikka gateway + LiteLLM for protocol conversion) over rewriting threads on Mikka's own agent (Capy's way) and over new-api.
- Status: decided. Not yet implemented.
- Replaces: for model requests paid by Mikka 额度 or a person's own API key, the "no placeholder/provider forwarding" part of [2026-11-06-1800](2026-11-06-1800-machine-is-the-execution-boundary.md) and the direct API-key delivery to CLIs. Builds on [2026-11-15-1900](2026-11-15-1900-models-on-gateway-like-capy.md).

## 规则

1. **一个网关。** Bot 对话、Coordinator 和线程里的 Claude Code / Codex，凡是用 Mikka 额度或用户自己 API Key 的模型请求，都先到 Mikka 网关。网关负责：认人、查余额、按请求实时计费（余额不够当场拦下，线程里出提示卡）、定来源、换来源不换模型、写用量记录。
2. **后面接什么。** Mikka 额度 → Vercel AI Gateway（Mikka 的 Key，原价）。用户的 Key → 厂商自己的入口，不经过 Vercel（Vercel 的 BYOK 失败会改用 Vercel 的 Key、记在 Mikka 账上）。
3. **协议转换用 LiteLLM。** Claude Code 只讲 Anthropic messages，Codex 只讲 Responses；厂商只讲 Chat completions 时，由网关后面的 LiteLLM 转换，每次请求带上用户的 Key 和地址。账只记在 Mikka。
4. **连接选协议（同 Capy）。** 自定义端点选 Chat completions / Responses / Anthropic messages，可关掉不支持的功能（strict、自定义工具、fallbacks、thinking）。
5. **机器上不放真 Key。** 机器只拿到一个只能调 Mikka 网关、绑定这次运行的短期令牌。
6. **订阅第一版直连。** Claude Code / Codex 的订阅登录照旧直连厂商；来源说明和用量记录仍由 Mikka 统一显示。
