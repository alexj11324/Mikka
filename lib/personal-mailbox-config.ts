/** Enabled in production; the explicit kill switch creates no user/snapshot grant. */
export function personalMailboxEnabled(): boolean { return process.env.MIKKA_PERSONAL_MAILBOX_ENABLED !== '0' }
