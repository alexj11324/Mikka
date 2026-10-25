// Local acceptance only. Candidate provider adapter and approval service unchanged.
const origin = 'http://127.0.0.1:3129'
async function read(path: string) { const r = await fetch(origin + path, { cache: 'no-store' }); if (!r.ok) throw new Error('fixture unavailable'); return r.json() }
export class Composio {
  constructor(options: { apiKey: string }) { if (process.env.ACCEPTANCE_LOCAL_ONLY !== '1' || options.apiKey !== 'synthetic-208-local-only') throw new Error('fixture-only SDK') }
  connectedAccounts = { list: async (args: { toolkitSlugs: string[] }) => read('/accounts?toolkit=' + args.toolkitSlugs[0]) }
  tools = {
    getRawComposioToolBySlug: async () => read('/tool'),
    execute: async (slug: string, params: { userId: string; arguments: Record<string, unknown> }, hooks?: { signal: AbortSignal; beforeExecute: (value: { params: unknown }) => Promise<unknown> }) => {
      if (slug === 'GOOGLECALENDAR_EVENTS_GET') return read('/event?id=' + encodeURIComponent(String(params.arguments.event_id)))
      if (!hooks) throw new Error('writes require authorization hook')
      await read('/tool'); await hooks.beforeExecute({ params }); hooks.signal.throwIfAborted()
      const action = slug === 'GMAIL_SEND_EMAIL' ? 'send_email' : slug === 'GOOGLECALENDAR_PATCH_EVENT' ? 'update_calendar_event' : 'create_calendar_event'
      const response = await fetch(origin + '/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, action }), signal: hooks.signal })
      return response.json()
    },
  }
}
