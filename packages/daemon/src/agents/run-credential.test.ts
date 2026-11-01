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
  it("gives Claude Code an API key, or an Anthropic-compatible base URL plus key, in its env", () => {
    expect(claudeCredentialEnv({ kind: "api_key", key: "k1" })).toEqual({ ANTHROPIC_API_KEY: "k1" })
    expect(claudeCredentialEnv({ kind: "provider", protocol: "anthropic", baseUrl: "https://llm.example.com/anthropic", key: "k2" }))
      .toEqual({ ANTHROPIC_API_KEY: "k2", ANTHROPIC_BASE_URL: "https://llm.example.com/anthropic" })
    expect(() => claudeCredentialEnv({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "k" })).toThrow()
    expect(claudeCredentialEnv(undefined)).toEqual({})
  })

  it("gives Codex a custom model provider whose key stays in the env, never in its arguments", () => {
    const custom = codexCredential({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "secret-key" })
    expect(custom.args).toContain('model_providers.mikka.base_url="https://llm.example.com/v1"')
    expect(custom.args).toContain('model_provider="mikka"')
    expect(custom.args.join(" ")).not.toContain("secret-key")
    expect(custom.env).toEqual({ MIKKA_MODEL_API_KEY: "secret-key" })
    expect(codexCredential({ kind: "api_key", key: "k" }).args).toContain('model_providers.mikka.base_url="https://api.openai.com/v1"')
    expect(() => codexCredential({ kind: "provider", protocol: "anthropic", baseUrl: "https://llm.example.com", key: "k" })).toThrow()
    expect(codexCredential(undefined)).toEqual({ args: [], env: {} })
  })

  it("refuses a non-HTTPS endpoint, a URL carrying a login, or a key that could split a header", () => {
    for (const baseUrl of ["http://llm.example.com/v1", "https://user:pw@llm.example.com/v1"]) {
      expect(() => codexCredential({ kind: "provider", protocol: "openai", baseUrl, key: "k" })).toThrow()
    }
    expect(() => claudeCredentialEnv({ kind: "api_key", key: "a\nb" })).toThrow()
    expect(() => claudeCredentialEnv({ kind: "api_key", key: "" })).toThrow()
  })

  it("names the provider host for the run's network policy", () => {
    expect(credentialDomain({ kind: "provider", protocol: "openai", baseUrl: "https://llm.example.com/v1", key: "k" })).toBe("llm.example.com")
    expect(credentialDomain({ kind: "api_key", key: "k" })).toBeUndefined()
  })
})
