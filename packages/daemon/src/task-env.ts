// 4e3: workspace secrets/env reach a hosted task through this channel only. The claim response's
// `taskEnv` is the explicit user variable set; the platform env guard in spawnHosted stays as is and
// these names are added after it. A user variable can never replace a platform variable.

/** Names the runner owns: the platform env built for the task, plus anything that steers the runtime, git or the broker. */
const RESERVED = /^(?:PATH|HOME|SHELL|USER|LOGNAME|PWD|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|GIT_.*|SSH_.*|DOCKER_.*|MIKKA_.*|CLAUDE_.*|CODEX_.*|ANTHROPIC_.*|OPENAI_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy)$/
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
export function withoutTaskEnv<T extends { taskEnv?: unknown }>(assignment: T): Omit<T, "taskEnv"> {
  if (!("taskEnv" in assignment)) return assignment
  const { taskEnv: _drop, ...rest } = assignment
  return rest
}
