/**
 * Cloud computer tasks (Mikka Cloud runs on the person's own E2B) are on by
 * default. `MIKKA_CLOUD_COMPUTER_TASKS=0` is the kill switch for a live
 * incident; an admin turns computer use off per workspace in its policy.
 */
export function cloudComputerTasksEnabled(env: Record<string, string | undefined> = process.env) {
  return env.MIKKA_CLOUD_COMPUTER_TASKS !== '0'
}
