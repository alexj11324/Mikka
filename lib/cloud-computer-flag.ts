import { deploymentSwitch } from '@/lib/deployment-switches'
type Env = Record<string, string | undefined>

/**
 * Cloud computer tasks run only on the person's own E2B key, and the key is
 * enough: no flag has to turn them on. PostHog's mikka-cloud-computer-tasks-off
 * (lib/deployment-switches.ts) is the kill switch for a live incident; an admin turns computer use off per
 * workspace in its policy.
 */
export function cloudComputerTasksEnabled(env: Env = process.env) {
  return deploymentSwitch('cloudComputerTasks', env)
}

/** The subscription (BYOS) backend: PostHog's mikka-byos (lib/deployment-switches.ts). */
export function byosEnabled(env: Env = process.env) {
  return deploymentSwitch('byos', env)
}

/** Subscription enrollment custody: PostHog's mikka-byos-enrollment (lib/deployment-switches.ts). */
export function byosEnrollmentEnabled(env: Env = process.env) {
  return deploymentSwitch('byosEnrollment', env)
}

/** A cloud computer run needs both: cloud computer tasks not killed and the BYOS backend on. */
export function cloudComputerRunsEnabled(env: Env = process.env) {
  return cloudComputerTasksEnabled(env) && byosEnabled(env)
}
