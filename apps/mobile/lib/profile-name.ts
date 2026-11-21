import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/version'

type Receipt = { version?: number; ok?: boolean; result?: { name?: string; error?: string } }
type Request = (path: string, init: { method: 'POST'; body: unknown }) => Promise<Receipt | null>

export async function saveProfileName(name: string, request: Request): Promise<string> {
  const receipt = await request('/api/rpc', {
    method: 'POST',
    body: { version: DESKTOP_RPC_VERSION, action: 'account.updateDisplayName', args: [name] },
  })
  if (receipt?.version !== DESKTOP_RPC_VERSION || receipt.ok !== true || receipt.result?.error || typeof receipt.result?.name !== 'string' || !receipt.result.name.trim()) {
    throw new Error('profile_name_unconfirmed')
  }
  return receipt.result.name
}
