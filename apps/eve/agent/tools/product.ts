import {evaluationForSession,evaluationNativeTools} from '../../../../lib/eve/evaluation-runtime'
import { defineDynamic } from 'eve/tools'
import { executionForSession } from '../../../../lib/eve/runtime'
import { productCatalogue } from '../../../../lib/eve/product-definitions'
import { createProductTool } from '../../../../lib/eve/product-tool'

/** Product actions keep their existing ownership, billing and audit boundaries. */
export default defineDynamic(async ctx => {
  const evaluation=await evaluationForSession(ctx)
  if(evaluation)return evaluationNativeTools(evaluation)
  const { scope, execution } = await executionForSession(ctx)
  const binding = {sessionId:ctx.session.id,turnId:ctx.turn!.id,executionId:execution?.id}
  const catalogue = await productCatalogue(scope,binding)
  return Object.fromEntries(catalogue.map(definition => [definition.name,createProductTool(scope,binding,definition)]))
})
