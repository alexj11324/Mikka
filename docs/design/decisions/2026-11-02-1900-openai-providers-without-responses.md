# A custom OpenAI provider without the Responses API is saved for bot chats, not Codex

- Date: 2026-11-02
- Source: coordinator session, option B for chat-only custom OpenAI providers: save the key as before; its row says 「不支持 Responses API · Codex 用不了」; Codex does not list its models; bot chats keep working; the check costs nothing.
- Rule: —
- Replaces: —

**Why.** The daemon runs Codex on the Responses API only
(`wire_api = "responses"`, `packages/daemon/src/agents/run-credential.ts`).
Many OpenAI-compatible gateways serve Chat Completions only, which is
enough for a bot chat (Mikka's own harness) but not for Codex.

**The check.** For a custom provider on the OpenAI protocol, adding the key
and 重新获取模型 send one `POST {base}/responses` with an empty JSON body
(`probeResponsesApi` in `lib/model-api-keys.ts`). No model is named, so a
server that has the API refuses the body (400) and bills nothing. A
404/405/501 means it has no such route: `model_api_keys."responsesApi"` is
false. Any other answer, a timeout included, keeps what was known (true for
a new key). The presets are not asked; their OpenAI endpoints serve it.

**What changes.** Such a key serves no Agent (`apiKeyHarnesses` is empty for
it): 允许使用的模型 does not offer its models, and `apiKeyForRun` opens
nothing for a Codex run. Bot chats still pick and use it. Its row reads
「OpenAI 协议 · 不支持 Responses API · Codex 用不了」 in place of
「OpenAI 协议 · 可用 Codex」. 重新获取模型 asks again, so a provider that
adds the API later becomes usable by Codex.
