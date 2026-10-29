/** Expected personal mailbox admission or request failure. No runtime imports. */
export class MailboxError extends Error {
  constructor(message: string, public status = 403, public commitState?: 'committed' | 'unconfirmed') { super(message) }
}
