// A Claude Code configured for a custom API gateway keeps the address and token
// in the `env` of its user settings. Runs load no host settings (ADR 0009), so
// without this they fall back to the login, which such a machine may not have.
// Only these variables cross the boundary; hooks, plugins and permissions do not.
import { readFileSync } from "node:fs"
import { join } from "node:path"

const GATEWAY_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const

export interface ClaudeGateway {
  env: Record<string, string>
  /** The gateway's host, the one address the run's sandbox must add for it. */
  domain: string
}

/** The gateway in `<configDir>/settings.json`, or null when Claude Code uses its own login. */
export function readClaudeGateway(configDir: string): ClaudeGateway | null {
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))
  } catch {
    return null
  }
  const declared = (settings as { env?: unknown } | null)?.env
  if (!declared || typeof declared !== "object") return null
  const values = declared as Record<string, unknown>
  const domain = gatewayDomain(values.ANTHROPIC_BASE_URL)
  if (!domain) return null
  const env: Record<string, string> = {}
  for (const name of GATEWAY_ENV) {
    const value = values[name]
    if (typeof value === "string" && value) env[name] = value
  }
  return { env, domain }
}

function gatewayDomain(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string") return null
  try {
    const url = new URL(baseUrl)
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : null
  } catch {
    return null
  }
}
