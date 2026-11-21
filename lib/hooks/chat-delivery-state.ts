import { useEffect, type Dispatch, type SetStateAction } from 'react'

export type ChatSubmission = { id: string; text: string; at: number }
export type ChatDelivery<T extends ChatSubmission> = T & { phase: 'sending' | 'accepted' | 'failed'; error?: string; storedId?: string }
const inFlight = new Set<string>()

/** All chat entries journal the immutable command before starting asynchronous preflight or transport. */
export function useChatDeliveryState<T extends ChatSubmission>(rows: ChatDelivery<T>[], setRows: Dispatch<SetStateAction<ChatDelivery<T>[]>>, uncertain: string) {
  // A page reload may interrupt the response. Only the originating command can recover its result.
  useEffect(() => {
    const interrupted = rows.filter(row => row.phase === 'sending' && !inFlight.has(row.id))
    if (interrupted.length) setRows(current => current.map(row => interrupted.some(item => item.id === row.id) && row.phase === 'sending' ? { ...row, phase: 'failed', error: uncertain } : row))
  }, [rows, setRows, uncertain])
  function begin(command: T) {
    if (inFlight.has(command.id)) return false
    inFlight.add(command.id)
    setRows(current => current.some(row => row.id === command.id)
      ? current.map(row => row.id === command.id ? { ...row, phase: 'sending', error: undefined } : row)
      : [...current, { ...command, phase: 'sending' }])
    return true
  }
  function finish(id: string, result: { error: string } | { storedId?: string }) {
    inFlight.delete(id)
    setRows(current => current.map(row => row.id !== id ? row : 'error' in result
      ? { ...row, phase: 'failed', error: result.error } : { ...row, phase: 'accepted', storedId: result.storedId }))
  }
  return { rows, setRows, begin, finish }
}
