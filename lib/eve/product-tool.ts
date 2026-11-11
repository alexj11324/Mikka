import { defineTool } from 'eve/tools'
import type { ApprovalConfiguration } from 'eve/tools/approval'
import { isEveApprovalResponder } from './approval-principal'
import { productRpc, type ProductCatalogueEntry } from './product-rpc'
import type { EveScope } from './scope'

type Binding = {sessionId:string;turnId:string;executionId?:string}
type ApprovalReview = {status:'not-applicable'|'denied'|'user-approval'}

/** Eve owns the pause and approved resumption. The product gateway retains the
 * exact business write plan and rechecks policy before provider dispatch. */
export function createProductTool(scope:EveScope,binding:Binding,definition:ProductCatalogueEntry,rpc:typeof productRpc=productRpc) {
  const approval:ApprovalConfiguration<unknown> = {
    async request(ctx) {
      if (ctx.session.id !== binding.sessionId || ctx.session.turn.id !== binding.turnId || !isEveApprovalResponder(scope,ctx.session.auth.current)) return 'denied'
      const review = await rpc<ApprovalReview>(scope,{...binding,operation:'approval',name:definition.name,input:ctx.toolInput,callId:ctx.callId},ctx.abortSignal)
      return ['not-applicable','denied','user-approval'].includes(review.status) ? review.status : 'denied'
    },
    response(ctx) {
      const allowed = ctx.session.id === binding.sessionId && ctx.session.turn.id === binding.turnId &&
        isEveApprovalResponder(scope,ctx.request.principal) && isEveApprovalResponder(scope,ctx.response.principal)
      return allowed ? {status:'allowed'} : {status:'rejected',reason:'workspaceAccessDenied'}
    },
  }
  return defineTool({
    description:definition.description,
    inputSchema:definition.inputSchema as never,
    approval,
    async execute(input:unknown,ctx) {
      const principal = ctx.approval?.responder
      // Copy identity data only. A public Eve responder also has getToken(),
      // which is a local capability and never part of the service request.
      const approvalResponder = principal ? {
        authenticator:principal.authenticator,principalType:principal.principalType,principalId:principal.principalId,
        attributes:{botId:principal.attributes.botId,workspaceId:principal.attributes.workspaceId,surface:principal.attributes.surface},
      } : undefined
      return (await rpc<{output:unknown}>(scope,{...binding,operation:'execute',name:definition.name,input,callId:ctx.callId,...approvalResponder ? {approvalResponder} : {}},ctx.abortSignal)).output
    },
  })
}
