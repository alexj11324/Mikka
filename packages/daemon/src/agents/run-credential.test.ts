import { describe, expect, it } from "vitest"

import { harnessForModel } from "@mikka/protocol"
import { claudeCredentialEnv, codexCredential, credentialDomain } from "./run-credential"

describe("harnessForModel", () => {
  it("runs GPT/OpenAI models on Codex and everything else on Claude Code", () => {
    for (const model of ["gpt-5.5", "openai/gpt-5", "o4-mini", "codex-mini"]) expect(harnessForModel(model)).toBe("codex")
    for (const model of ["mikka-default", "claude-sonnet", "deepseek-v4", "kimi-k3", "glm-5"]) expect(harnessForModel(model)).toBe("claude_code")
  })

  it("takes a per-model override", () => {
    expect(harnessForModel("deepseek-v4", { "deepseek-v4": "codex" })).toBe("codex")
    expect(harnessForModel("gpt-5.5", { "gpt-5.5": "claude_code" })).toBe("claude_code")
  })
})

describe("run credentials", () => {
  it("gives Claude Code the gateway URL and run token in its env", () => {
    expect(claudeCredentialEnv({ kind: "provider", protocol: "anthropic", baseUrl: "https://mikka.test/api/model-gateway/anthropic", key: "k2" }))
      .toEqual({ ANTHROPIC_API_KEY: "k2", ANTHROPIC_BASE_URL: "https://mikka.test/api/model-gateway/anthropic" })
    expect(() => claudeCredentialEnv({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "k" })).toThrow()
    expect(claudeCredentialEnv(undefined)).toEqual({})
  })

  it("gives Codex a custom model provider whose key stays in the env, never in its arguments", () => {
    const custom = codexCredential({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "secret-key" })
    expect(custom.args).toContain('model_providers.mikka.base_url="https://llm.example.com/v1"')
    expect(custom.args).toContain('model_provider="mikka"')
    expect(custom.args.join(" ")).not.toContain("secret-key")
    expect(custom.env).toEqual({ MIKKA_MODEL_API_KEY: "secret-key" })
    expect(() => codexCredential({ kind: "provider", protocol: "anthropic", baseUrl: "https://llm.example.com", key: "k" })).toThrow()
    expect(codexCredential(undefined)).toEqual({ args: [], env: {} })
  })

  it("refuses legacy keys without a gateway endpoint before either CLI can use its provider default", () => {
    expect(() => claudeCredentialEnv({ kind: "api_key", key: "legacy-key" })).toThrow("Run credential unavailable")
    expect(() => codexCredential({ kind: "api_key", key: "legacy-key" })).toThrow("Run credential unavailable")
  })

  it("passes a scoped loopback gateway token to each CLI without admitting raw HTTP provider keys", () => {
    const key = 'mkg_' + 'a'.repeat(43)
    const baseUrl = 'http://127.0.0.1:3000/mikka/api/model-gateway/anthropic'
    expect(claudeCredentialEnv({ kind: 'provider', protocol: 'anthropic', baseUrl, key }))
      .toEqual({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: baseUrl })
    const codex = codexCredential({ kind: 'provider', protocol: 'openai', baseUrl: 'http://localhost:3000/api/model-gateway/openai/v1', key })
    expect(codex.args).toContain('model_providers.mikka.base_url="http://localhost:3000/api/model-gateway/openai/v1"')
    expect(codex.env).toEqual({ MIKKA_MODEL_API_KEY: key })
    expect(codex.args.join(' ')).not.toContain(key)
    for (const credential of [
      { baseUrl, key: 'provider-key' },
      { baseUrl: 'http://remote.example/api/model-gateway/anthropic', key },
      { baseUrl: 'http://127.0.0.1:3000/v1', key },
      { baseUrl: 'http://127.0.0.1:3000/api/model-gateway/openai/v1', key },
    ]) expect(() => claudeCredentialEnv({ kind: 'provider', protocol: 'anthropic', ...credential })).toThrow('Run credential unavailable')
  })

  it("refuses insecure remote endpoints, a URL carrying a login, or a key that could split a header", () => {
    for (const baseUrl of ["http://llm.example.com/v1", "https://user:pw@llm.example.com/v1", "https://llm.example.com/v1?token=key", "https://llm.example.com/v1#fragment"]) {
      expect(() => codexCredential({ kind: "provider", protocol: "openai", baseUrl, key: "k" })).toThrow()
    }
    for (const key of ["a\nb", ""]) expect(() => claudeCredentialEnv({ kind: "provider", protocol: "anthropic", baseUrl: "https://mikka.test/api/model-gateway/anthropic", key })).toThrow()
  })

  it("names the provider host for the run's network policy", () => {
    expect(credentialDomain({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "k" })).toBe("llm.example.com")
    expect(credentialDomain({ kind: "api_key", key: "k" })).toBeUndefined()
  })
})
