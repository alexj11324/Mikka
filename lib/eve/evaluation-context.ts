import type { AuthResult } from 'eve/channels/auth'

/** Only the service-authenticated evaluation channel can install this binding. */
export function evaluationBindingId(auth:AuthResult|null|undefined):string|null {
  const value=auth?.attributes?.evaluationBindingId
  return auth?.authenticator==='mikka'&&typeof value==='string'?value:null
}
