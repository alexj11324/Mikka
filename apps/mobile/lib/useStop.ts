import { useEffect, useState } from 'react'
import { STOP_CAP_MS, stopStuck, stopWithin, type StopAttempt } from '@/lib/stop'

/**
 * 停止 for a chat or a thread: `stop` sends `request` (capped at 10 seconds)
 * and then `after` (a reload); `sending` while it is out, so stop is not sent
 * twice; `stuck` when it failed or the work is still going 10 seconds later,
 * for 「没停下 · 重试」.
 */
export function useStop(request: () => Promise<unknown>, working: boolean, after: () => Promise<void>) {
  const [attempt, setAttempt] = useState<StopAttempt | null>(null)
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { if (!working) setAttempt(null) }, [working])
  // Wake once the cap has passed, so a stop the server took but did not act on is seen.
  useEffect(() => {
    if (!attempt || attempt.failed) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, attempt.at + STOP_CAP_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [attempt])
  const stop = async () => {
    const at = Date.now()
    setSending(true)
    setAttempt({ at, failed: false })
    if (!await stopWithin(request)) setAttempt({ at, failed: true })
    setNow(Date.now())
    try { await after() } finally { setSending(false) }
  }
  return { stop, sending, stuck: stopStuck(attempt, working, now) }
}
