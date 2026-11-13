import type { AgentExecution } from '../agent-kit/store'
import { internalEveHeaders } from './auth'
import type { EveScope } from './scope'
import type { ApprovalPrincipal } from './approval-principal'
import type { TurnOutcome } from 'eve/events'

export interface ProductCatalogueEntry { name:string; description:string; inputSchema:Record<string,unknown> }
export type ProductOperation = {operation:'prepare'|'instructions'|'catalogue'|'approval'|'execute'|'finish';sessionId:string;turnId:string;executionId?:string;name?:string;input?:unknown;callId?:string;approvalResponder?:ApprovalPrincipal;outcome?:TurnOutcome;messages?:unknown[]}
export interface PreparedProductExecution {execution:AgentExecution|null;runtime:import('../subscription-model-snapshot').HostedRuntimeSnapshot}

/** Business actions execute on the app host, whose Workflow World owns task jobs. */
export async function productRpc<T>(scope:EveScope,operation:ProductOperation,signal?:AbortSignal):Promise<T> {
  const hosted = process.env.MIKKA_EVE_HOST === 'cloudflare'
  const origin = hosted ? 'https://product.internal' : process.env.MIKKA_APP_ORIGIN ?? process.env.BETTER_AUTH_URL ?? 'http://127.0.0.1:3000'
  const capability = hosted ? process.env.MIKKA_EVE_PRODUCT_TOKEN : undefined
  if (hosted && !capability) throw new Error('agentToolUnavailable')
  const response = await fetch(new URL('/mikka/api/internal/eve/tools',origin),{
    method:'POST',redirect:'error',headers:{...internalEveHeaders(scope),'content-type':'application/json',
      ...(capability ? {'x-mikka-product-capability':capability} : {})},
    body:JSON.stringify(operation),signal,
  })
  if (!response.ok) throw new Error('agentToolUnavailable')
  return await response.json() as T
}
export const prepareEveExecution = (scope:EveScope,sessionId:string,turnId:string) => productRpc<PreparedProductExecution>(scope,{operation:'prepare',sessionId,turnId})
