import { WORKSPACE_ID } from './session-vault'

export function rpcEnvelope(body: BodyInit | null | undefined): { version: 0 | 1; action: string; args: unknown[] } | null {
  let text: string
  if (typeof body === 'string') text = body
  else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body)
  else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  else return null
  if (text.length > 2 * 1024 * 1024) return null
  try {
    const value = JSON.parse(text) as { version?: unknown; action?: unknown; args?: unknown }
    return (value.version === 0 || value.version === 1) && typeof value.action === 'string' && Array.isArray(value.args) ? value as { version: 0 | 1; action: string; args: unknown[] } : null
  } catch { return null }
}

export function responseWorkspace(headers: Headers): string | null | undefined {
  const selected = /(?:^|,\s*)mikka-workspace=([^;,]*)/.exec(headers.get('set-cookie') ?? '')?.[1]
  return selected === '' ? null : selected && WORKSPACE_ID.test(selected) ? selected : undefined
}

export interface AccountChoice { id: string; email: string; choices: { id: string; name: string; kind?: 'personal' | 'team' }[] }

/** Only identity/workspace display fields survive another account's response. */
export function accountChoice(value: unknown, userId: string): AccountChoice | null {
  if (!value || typeof value !== 'object') return null
  const accounts = (value as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return null
  const own = accounts.find(item => item && typeof item === 'object' && item.id === userId) as { id: string; email?: unknown; choices?: unknown } | undefined
  if (!own || typeof own.email !== 'string' || own.email.length > 320 || !Array.isArray(own.choices) || own.choices.length > 1000) return null
  const choices = own.choices.flatMap(item => item && typeof item === 'object' && typeof item.id === 'string' && WORKSPACE_ID.test(item.id) && typeof item.name === 'string' && item.name.length <= 500 ? [{ id: item.id, name: item.name, ...(item.kind === 'personal' || item.kind === 'team' ? { kind: item.kind } : {}) }] : [])
  return { id: own.id, email: own.email, choices }
}
