import 'server-only'
import type { WakeAdmission } from './inbox-receipts'
// A server-installed resource-policy function, not in-memory quota or authority.
// Public core defines only the contract. Organization/operator/managed adapters
// are deliberately absent pending the user's public/private product boundary.
let installed: WakeAdmission | undefined
export function configureWakeAdmission(adapter: WakeAdmission) {
  if (installed && installed !== adapter) throw new Error('wakeAdmissionAlreadyConfigured')
  installed = adapter
}
export const resourceWakeAdmission: WakeAdmission = async (scope, phase) =>
  installed ? installed(scope, phase) : { admitted: false, retryAt: new Date(Date.now() + 60000) }
