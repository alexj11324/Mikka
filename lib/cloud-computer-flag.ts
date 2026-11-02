type Env = Record<string, string | undefined>

/**
 * Cloud computer tasks run only on the person's own E2B key, and the key is
 * enough: no flag has to turn them on. `MIKKA_CLOUD_COMPUTER_TASKS=0` is the
 * kill switch for a live incident; an admin turns computer use off per
 * workspace in its policy.
 */
export function cloudComputerTasksEnabled(env: Env = process.env) {
  return env.MIKKA_CLOUD_COMPUTER_TASKS !== '0'
}

/** `MIKKA_BYOS_ENABLED=1`: the subscription (BYOS) backend is on. */
export function byosEnabled(env: Env = process.env) {
  return env.MIKKA_BYOS_ENABLED === '1'
}

/**
 * `MIKKA_BYOS_VALIDATED_MODEL_ROUTES`: the subscription routes that answer bot chats. The model menu,
 * the bot's model resolver and the subscription runtime all read this one list, so a subscription whose
 * route is not on it is never offered and never picked.
 */
export function subscriptionChatRoutes(env: Env = process.env): Set<string> {
  return new Set((env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES ?? '').split(',').filter(route => ['codex_cpa', 'claude_cpa'].includes(route)))
}
export function subscriptionChatRouteReady(route: string, env: Env = process.env) {
  return subscriptionChatRoutes(env).has(route)
}

/** `MIKKA_BYOS_ENROLLMENT_ENABLED=1`: subscription enrollment custody is on. */
export function byosEnrollmentEnabled(env: Env = process.env) {
  return env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1'
}

/** A cloud computer run needs both: cloud computer tasks not killed and the BYOS backend on. */
export function cloudComputerRunsEnabled(env: Env = process.env) {
  return cloudComputerTasksEnabled(env) && byosEnabled(env)
}
