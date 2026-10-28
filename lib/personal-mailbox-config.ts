/** Host rollout gate. Configuration creates no per-user or snapshot grant. */
export function personalMailboxEnabled(): boolean { return process.env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1' }
