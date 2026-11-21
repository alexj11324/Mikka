import type { ThreadScreenProps, ThreadTranscriptScreenProps } from './thread-contract'
import { ThreadTranscript } from './thread-transcript'

/** Full conversation is an official client renderer. The server imports only its contract. */
export function ThreadScreen(props: ThreadScreenProps | ThreadTranscriptScreenProps) {
  if ('transcript' in props) return <ThreadTranscript {...props} />
  throw new Error('Required official UI slot thread.ThreadScreen is unavailable')
}
