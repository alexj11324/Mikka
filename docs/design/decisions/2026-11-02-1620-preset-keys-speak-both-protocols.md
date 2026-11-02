# A preset API key runs on every Agent its provider's API speaks to

- Date: 2026-11-02
- Source: Alex, Harness draft (Artifact GnZnsPYEDJdkHBUJHzB5SJ, Version 2; Figma zPe5LKycb2XuT1ivCLRw07 page 855:2), relayed by the coordinator session: DeepSeek, Kimi and the like are presets whose official APIs speak both the Anthropic and the OpenAI protocol; adding one asks only for the key, never a protocol, and both Agents can use it. Only a custom provider picks its protocol.
- Rule: —
- Replaces: in [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md), "An API key's Agent follows its protocol" as one protocol per key.

**A key's protocols.** A preset serves every protocol its official API
speaks, each at its own endpoint (`API_KEY_PRESET_ENDPOINTS` in
`lib/model-api-key-providers.ts`):

| Preset | Anthropic (Claude Code) | OpenAI (Codex) |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com` | — |
| OpenAI | — | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/v1` |
| Kimi | `https://api.moonshot.cn/anthropic` | `https://api.moonshot.cn/v1` |

Sources: api-docs.deepseek.com (base_url for OpenAI and for Anthropic) and
platform.kimi.ai/docs/api/overview (OpenAI Chat Completions and Responses at
`/v1`, Anthropic Messages at `/anthropic`). Mikka runs Codex on the
Responses API. Kimi documents it. DeepSeek's docs list only chat
completions; the coordinator tested its Responses endpoint before this
decision.

A custom provider serves the one protocol the person picked.

**Where it shows.** 添加 API Key lists the providers with what each runs on
(「Anthropic、OpenAI 协议 · 可用 Claude Code、Codex」); a preset takes only its
key; 自定义服务商 reads 「选了协议才知道能用哪个 Agent」 and its protocol options
name the Agent (「OpenAI 协议 · 可用 Codex」). A key row ends with the same
line. 添加模型 lists a two-protocol key's model once per Agent
(model · Agent).

**At run time.** The run's Agent picks the key's endpoint (`apiKeyForRun`
takes the Agent); a key that does not speak it opens nothing and the run
ends.

**Untouched list.** A model a key serves on both Agents counts once in the
default, on Claude Code, the preferred Agent by default.
