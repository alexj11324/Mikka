import { subagentEventSchema } from '@mikka/protocol/subagent'
import { withBasePath } from '@/lib/base-path'
import { listenComputerStream } from '@/lib/computer/event-stream'

export type SubagentUpdate = ReturnType<typeof subagentEventSchema.shape.data.parse>
export type LoginNeed = { subagentId: string; botId: string; origin: string; name: string; prefix: string }

/** `needs.site` may be a bare host or a URL; only http(s) origins can be signed into. */
export function siteOrigin(site: string): { origin: string; name: string } | null {
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(site) ? site : `https://${site}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { origin: url.origin, name: url.hostname.replace(/^www\./, '') }
  } catch { return null }
}

/** Keeps the latest update per sub-agent; a sub-agent asks for a login only while it waits on you with needs.kind === 'login'. */
export function applySubagentUpdate(state: ReadonlyMap<string, SubagentUpdate>, update: SubagentUpdate): Map<string, SubagentUpdate> {
  const next = new Map(state)
  next.set(update.subagentId, update)
  return next
}

export function loginNeeds(state: ReadonlyMap<string, SubagentUpdate>, botId: string): LoginNeed[] {
  const needs: LoginNeed[] = []
  for (const update of state.values()) {
    if (update.botId !== botId || update.state !== 'needs_you' || update.needs?.kind !== 'login') continue
    const site = siteOrigin(update.needs.site)
    if (!site) continue
    needs.push({ subagentId: update.subagentId, botId, ...site, prefix: withBasePath(`/api/bots/${botId}/subagents/${update.subagentId}/credentials`) })
  }
  return needs
}

/** Shares the tab's one /api/computer/events stream. It sends `event: data-subagent` with the event's `data` as the payload. */
export function subscribeSubagentUpdates(listener: (update: SubagentUpdate) => void): () => void {
  return listenComputerStream('data-subagent', data => {
    const parsed = subagentEventSchema.shape.data.safeParse(safeJson(data))
    if (parsed.success) listener(parsed.data)
  })
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}
