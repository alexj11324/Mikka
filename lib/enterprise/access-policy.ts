import type { EnterprisePrincipal } from './principal'
export type EnterpriseAccessState = { managedRevoked: boolean; enforceSso: boolean; allowMachineCredentials: boolean; credentialValid: boolean; sessionAssured: boolean; breakGlass: boolean }
export function enterpriseAccessAllowed(state: EnterpriseAccessState, principal?: Pick<EnterprisePrincipal, 'kind'> | { kind: 'execution' }) {
  if (state.managedRevoked) return false
  if (!state.enforceSso) return true
  if (!principal || !state.credentialValid) return false
  return principal.kind === 'session' ? state.sessionAssured || state.breakGlass : state.allowMachineCredentials
}
