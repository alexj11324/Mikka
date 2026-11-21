import { withBasePath } from '@/lib/base-path'
import type { ThreadReadChange } from './thread-reads'

export async function setThreadRead(change: ThreadReadChange) {
  const result = await fetch(withBasePath('/api/conversations/read-state'), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  })
  if (!result.ok) throw new Error(`Thread read state: ${result.status}`)
}
