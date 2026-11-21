import type { ThreadScreenProps } from './thread-contract'

/** Full conversation is an official client renderer. The server imports only its contract. */
export function ThreadScreen(_props: ThreadScreenProps): never {
  throw new Error('Required official UI slot thread.ThreadScreen is unavailable')
}
