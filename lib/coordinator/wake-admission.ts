import 'server-only'
import type { WakeAdmission } from './inbox-receipts'
// A server-installed resource-policy function, not in-memory quota or authority.
// The default public bridge reads canonical quota and current policy only.
// It creates no allocation or membership; missing configuration stays deferred.
let installed: WakeAdmission | undefined
export function configureWakeAdmission(adapter: WakeAdmission) {
  if (installed && installed !== adapter) throw new Error('wakeAdmissionAlreadyConfigured')
  installed = adapter
}
export const resourceWakeAdmission: WakeAdmission = async (scope, phase) => {
  if(installed)return installed(scope,phase)
  if(!scope.workspaceId)return {admitted:false,retryAt:new Date(Date.now()+60000)}
  const {publicWakeAdmission}=await import('../resources/runtime')
  return publicWakeAdmission(scope,phase)
}
