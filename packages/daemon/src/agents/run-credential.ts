// The model credential a run is given at start: the Mikka model gateway's
// explicit base URL, protocol and run-scoped token. It reaches the
// CLI only through its environment, never a file or an argument.
//
// - Claude Code takes `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`.
// - Codex takes OpenAI-compatible endpoints as a custom model provider in
//   its run config (`-c model_providers.mikka...`), reading the key from
//   the env var it names.
import { runModelCredentialSchema } from "@mikka/protocol/device"

export type RunCredential =
  // Legacy assignments are recognized so they fail closed instead of using a CLI's default endpoint.
  | { kind: "api_key"; key: string }
  | { kind: "provider"; protocol: "anthropic" | "openai"; baseUrl: string; key: string }

const KEY_ENV = "MIKKA_MODEL_API_KEY"
function checked(credential: RunCredential) {
  if (credential.kind !== "provider") throw new Error("Run credential unavailable")
  if (!runModelCredentialSchema.safeParse(credential).success) throw new Error("Run credential unavailable")
  return credential
}

/** The gateway's host, which the run's network policy must allow. */
export function credentialDomain(credential: RunCredential | undefined): string | undefined {
  return credential?.kind === "provider" ? new URL(credential.baseUrl).hostname : undefined
}

export function claudeCredentialEnv(credential: RunCredential | undefined): Record<string, string> {
  if (!credential) return {}
  const value = checked(credential)
  if (value.protocol !== "anthropic") throw new Error("Claude Code takes Anthropic-compatible providers only")
  return {
    ANTHROPIC_API_KEY: value.key,
    ANTHROPIC_BASE_URL: value.baseUrl,
  }
}

/** `-c` overrides plus the env holding the key, for a Codex run. */
export function codexCredential(credential: RunCredential | undefined): { args: string[]; env: Record<string, string> } {
  if (!credential) return { args: [], env: {} }
  const value = checked(credential)
  if (value.protocol !== "openai") throw new Error("Codex takes OpenAI-compatible providers only")
  return {
    args: [
      "-c", 'model_provider="mikka"',
      "-c", 'model_providers.mikka.name="Mikka"',
      "-c", `model_providers.mikka.base_url=${JSON.stringify(value.baseUrl)}`,
      "-c", `model_providers.mikka.env_key="${KEY_ENV}"`,
      "-c", 'model_providers.mikka.wire_api="responses"',
    ],
    env: { [KEY_ENV]: value.key },
  }
}
