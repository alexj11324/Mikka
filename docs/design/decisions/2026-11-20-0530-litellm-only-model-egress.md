# 所有受 Mikka 管理的模型调用统一经 LiteLLM

- Date: 2026-11-20
- Source: Alex, [#2869](https://github.com/alexj11324/Mikka/issues/2869): 「所有模型调用必须经过后台的 LiteLLM」「之前的各条直连路径必须全部退役，不保留兜底、不保留开关」。
- Status: accepted routing requirement; implementation and production acceptance are tracked on #2869.
- Supersedes: the direct Vercel/provider egress and optional protocol-converter portions of [2026-11-15-2000](2026-11-15-2000-one-model-gateway.md), including the community default-model exception.

## 原因

只有 Chat Completions 的用户 Key 使用 LiteLLM，其他模型仍分散直连 Vercel、厂商、Workers AI 或自部署服务。模型选择、协议转换和花费证据因此分散，线程标题也无法只通过后台切换模型。统一出口让后台配置负责上游和实际模型。

## 规则

1. 应用、Worker 和 daemon 的 Mikka 管理模型调用，包括个人 API Key，统一经过后台 LiteLLM。应用只配置 `MIKKA_LITELLM_URL` 和 `MIKKA_LITELLM_MASTER_KEY`，不保留直连 fallback 或恢复旧路径的开关。
2. Coordinator、标题、Decisions 和 Planning 使用后台模型别名，分别为 `mikka-default`、`mikka-title`、`mikka-decision` 和 `mikka-planning`。转写也经过 LiteLLM，保留用户已授权的来源和模型。`mikka-title` 由 LiteLLM 配置映射到 GPT-6 Luna。其他上游与实际模型也在 LiteLLM 配置中选择，应用不写死厂商域名和模型。
3. Vercel AI Gateway、Neon AI Gateway、厂商、自部署模型和 Workers AI 都是 LiteLLM 的上游。用户 Key 只用于该次请求的指定来源；上游失败不能换成 Mikka 的 Key。
4. Mikka 保留现有身份、模型准入、预算预留、额度结算、usage 和 tracing。LiteLLM 的花费与调用回执用于核对同一次调用；缺失花费不能被当成已证明的零成本。
5. 机器只得到本次运行绑定的 Mikka 网关短期令牌；daemon 的 API-key 运行也回到此网关，再由 LiteLLM 发出请求。LiteLLM 主密钥不下发给 Agent。
6. 社区版同样必须部署 LiteLLM；旧 `MIKKA_DEFAULT_MODEL_*`、ZeroCat、Workers AI 和应用内独立 Decisions 上游配置不再恢复直连能力。
7. 官方 Claude Code / Codex 订阅 OAuth 暂时保留原有独立路径。这是 #2869 明确要求先验证、再由 Alex 决定的例外；没有证明 OAuth 令牌可经 LiteLLM 正确转发之前，不把订阅迁移声称为已完成。账户登录和额度查询也不属于模型推理出口。

## 验证与部署

`pnpm lint` 中的 LiteLLM policy 检查生产源文件的 SDK 构造和厂商模型域名，保留明确的订阅及路由元数据例外，并以失败反例验证检查本身。实际验收记录所测源码、LiteLLM 配置版本、别名、调用 ID、花费和 usage/额度记录；测试替身只证明协议，不证明真实模型映射或生产部署。

Cloud 的密钥、Vercel/Neon 上游配置、发布和回滚由私有 `mikka-cloud` 持有。更改公开源码或社区 Compose 不代表该配置已部署。
