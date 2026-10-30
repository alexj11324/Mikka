// 4e3: workspace secrets/env reach a hosted task through this channel only. The claim response's
// `taskEnv` is the explicit user variable set; the platform env guard in spawnHosted stays as is and
// these names are added after it. A user variable can never replace a platform variable.

/** Names the runner owns: the platform env built for the task, plus anything that steers the runtime, git or the broker. */
// Mirrors lib/secrets/format.ts RESERVED_ENV_NAME (keep in sync; tests/task-env.test pins both), plus the
// runner's own harness credentials.
const RESERVED = /^(?:PATH|HOME|SHELL|USER|LOGNAME|PWD|TMPDIR|TERM|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|SSL_CERT_.*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|GIT_.*|SSH_.*|E2B_.*|MIKKA_.*|DOCKER_.*|INFISICAL_.*|WORKSPACE_SECRETS_KEY|CLAUDE_.*|CODEX_.*|ANTHROPIC_.*|OPENAI_.*|DATABASE_URL|BASH_ENV|ENV|PROMPT_COMMAND|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|NPM_CONFIG_.*|PIP_INDEX_URL|PYTHONSTARTUP|GLOBAL_AGENT_HTTP_PROXY)$/i
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export interface TaskEnvResult { env: Record<string, string>; dropped: string[] }

/** platform env plus the user variables that do not collide with it or with a reserved name. Names only in `dropped`. */
export function withTaskEnv(platform: Record<string, string>, taskEnv: Record<string, string> | undefined): TaskEnvResult {
  const env = { ...platform }
  const dropped: string[] = []
  for (const [name, value] of Object.entries(taskEnv ?? {})) {
    if (typeof value !== "string" || !NAME.test(name) || RESERVED.test(name) || Object.hasOwn(platform, name)) { dropped.push(name); continue }
    env[name] = value
  }
  return { env, dropped }
}

/** The assignment as it may be written to disk: without the task's user variables. */
export function withoutTaskEnv<T extends object>(assignment: T): Omit<T, "taskEnv"> {
  if (!("taskEnv" in assignment)) return assignment
  const { taskEnv: _drop, ...rest } = assignment
  return rest
}
