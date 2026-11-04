# API keys are their own group; their models are the provider's

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session, after a DeepSeek key added in 「API 与订阅」 showed under the ChatGPT / Codex card and none of its models could be picked: 「API Key 应该自成一组，或者按服务商分组，不该挂在订阅下面。…模型列表只用服务商 /models 接口返回的值，不写死；拉取失败时在 key 那一行显示原因，并提供「重新获取模型」按钮；拉取成功后，输入框的模型菜单和「Bot 与 Agents」都能选到这些模型。」
- Rule: — (R-40 and R-74 stand)
- Superseded in part by: [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md) (key models move out of 「Bot 与 Agents」 into 模型与订阅)
- Replaces: orchestration.md § 1 "subscriptions, API keys and custom providers in one list", as to the layout only.

「API 与订阅」 shows the subscriptions (模型订阅) and the API keys (API Key)
as two groups, each with its own heading; 添加 API Key sits on the API Key
group.

- A key's models are what the provider's /models answered with that key
  (decision 2026-11-02-1030). A custom provider added with its own list keeps
  it when the provider lists nothing.
- Each key row shows how many models that was, with 重新获取模型. When the
  provider gave none, or the last ask failed, the row says so instead (Key
  无效或已被撤销, or 服务商没有响应). A failed ask keeps the last list.
- The key's models can be picked in the composer's model menu (when the key
  reaches bot chats) and in 「Bot 与 Agents」, under the Agent its protocol
  needs (OpenAI → Codex, others → Claude Code), on Mikka Cloud and on any
  device where that Agent is installed.
- A run whose model only a key lists runs on that key, also when a
  subscription for that Agent is connected: a subscription is never asked for
  a model its account's catalogue does not have. A model both list stays on
  the subscription (orchestration.md § 2).
