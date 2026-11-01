// The model credential a run is given at start (devices are runners,
// 2026-10-31), besides a subscription lease (`subscriptionAuth`): an API
// key, or a custom provider's base URL, protocol and key. It reaches the
// CLI only through its environment, never a file or an argument.
//
// - Claude Code takes Anthropic-compatible endpoints: `ANTHROPIC_API_KEY`
//   and, for a custom provider, `ANTHROPIC_BASE_URL`.
// - Codex takes OpenAI-compatible endpoints as a custom model provider in
//   its run config (`-c model_providers.mikka...`), reading the key from
//   the env var it names.

export type RunCredential =
  | { kind: "api_key"; key: string }
  | { kind: "provider"; protocol: "anthropic" | "openai"; baseUrl: string; key: string }

const KEY_ENV = "MIKKA_MODEL_API_KEY"
const OPENAI_BASE_URL = "https://api.openai.com/v1"

function checked(credential: RunCredential) {
  if (!credential.key || credential.key.length > 32768 || /[\r\n\0]/.test(credential.key)) throw new Error("Run credential unavailable")
  if (credential.kind === "provider") {
    const url = new URL(credential.baseUrl)
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Run credential unavailable")
  }
  return credential
}

/** The provider's host, which the run's network policy must allow. */
export function credentialDomain(credential: RunCredential | undefined): string | undefined {
  return credential?.kind === "provider" ? new URL(credential.baseUrl).hostname : undefined
}

export function claudeCredentialEnv(credential: RunCredential | undefined): Record<string, string> {
  if (!credential) return {}
  const value = checked(credential)
  if (value.kind === "provider" && value.protocol !== "anthropic") throw new Error("Claude Code takes Anthropic-compatible providers only")
  return {
    ANTHROPIC_API_KEY: value.key,
    ...(value.kind === "provider" ? { ANTHROPIC_BASE_URL: value.baseUrl } : {}),
  }
}

/** `-c` overrides plus the env holding the key, for a Codex run. */
export function codexCredential(credential: RunCredential | undefined): { args: string[]; env: Record<string, string> } {
  if (!credential) return { args: [], env: {} }
  const value = checked(credential)
  if (value.kind === "provider" && value.protocol !== "openai") throw new Error("Codex takes OpenAI-compatible providers only")
  const baseUrl = value.kind === "provider" ? value.baseUrl : OPENAI_BASE_URL
  return {
    args: [
      "-c", 'model_provider="mikka"',
      "-c", 'model_providers.mikka.name="Mikka"',
      "-c", `model_providers.mikka.base_url=${JSON.stringify(baseUrl)}`,
      "-c", `model_providers.mikka.env_key="${KEY_ENV}"`,
      "-c", 'model_providers.mikka.wire_api="responses"',
    ],
    env: { [KEY_ENV]: value.key },
  }
}
