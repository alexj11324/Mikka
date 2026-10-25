// Clean environment for agent CLI children and setup recipes (ADR 0009).
// Built from an allow-list; nothing from the host leaks in by default.

/** Host variables every child may see. */
export const BASE_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
] as const

/**
 * Never inherited, even if an adapter declares them: host MCP / Claude
 * config, cloud and forge credentials, and the daemon's own variables.
 */
export const ENV_DENY_PATTERNS: readonly RegExp[] = [
  /^CLAUDE_/,
  /^MCP_/,
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCLOUD_/,
  /^CLOUDSDK_/,
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^NPM_TOKEN$/,
  /^MIKKA_/,
  /^ELECTRON_/,
  /^NODE_OPTIONS$/,
  /SECRET/,
  /PASSWORD/,
  /_TOKEN$/,
  /_API_KEY$/,
]

export function isDeniedEnvName(name: string): boolean {
  return ENV_DENY_PATTERNS.some((pattern) => pattern.test(name))
}

export interface ChildEnvOptions {
  host?: NodeJS.ProcessEnv
  /** Host variable names the adapter declares it needs. */
  adapterAllow?: readonly string[]
  runId?: string
}

/** Environment for a spawned child; pass with `extendEnv: false`. */
export function buildChildEnv(
  options: ChildEnvOptions = {}
): Record<string, string> {
  const host = options.host ?? process.env
  const env: Record<string, string> = {}
  for (const name of [...BASE_ENV_ALLOW, ...(options.adapterAllow ?? [])]) {
    const value = host[name]
    if (value !== undefined && !isDeniedEnvName(name)) env[name] = value
  }
  if (options.runId) env.MIKKA_RUN_ID = options.runId
  return env
}
