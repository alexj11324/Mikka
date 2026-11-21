import {evaluationForSession,evaluationNativeTools} from '../../../../lib/eve/evaluation-runtime'
import { defineDynamic } from 'eve/tools'
import { turnModel, turnPolicy, turnRequest } from '../../../../lib/eve/runtime'
import { scopeFromAuth } from '../../../../lib/eve/scope'
import { productCatalogue } from '../../../../lib/eve/product-definitions'
import { createProductTool } from '../../../../lib/eve/product-tool'

/** Product actions keep their existing ownership, billing and audit boundaries. */
export default defineDynamic(async ctx => {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationNativeTools(evaluation)
  const scope = scopeFromAuth(ctx.session.auth.current)
  const policy = turnPolicy.get()
  const runtime = turnModel.get()!
  const request = turnRequest.get()
  const binding = {sessionId:ctx.session.id,turnId:ctx.turn!.id}
  const catalogue = await productCatalogue(scope,binding,policy,runtime,request)
  return Object.fromEntries(catalogue.map(definition => [definition.name,createProductTool(scope,binding,definition)]))
})
