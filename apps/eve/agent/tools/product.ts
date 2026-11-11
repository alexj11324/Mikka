import { defineDynamic } from 'eve/tools'
import { executionForSession } from '../../../../lib/eve/runtime'
import { productRpc, type ProductCatalogueEntry } from '../../../../lib/eve/product-rpc'
import { createProductTool } from '../../../../lib/eve/product-tool'

/** Product actions keep their existing ownership, billing and audit boundaries. */
export default defineDynamic(async ctx => {
  const { scope, execution } = await executionForSession(ctx)
  const binding = {sessionId:ctx.session.id,turnId:ctx.turn!.id,executionId:execution?.id}
  const {tools:catalogue} = await productRpc<{tools:ProductCatalogueEntry[]}>(scope,{...binding,operation:'catalogue'})
  return Object.fromEntries(catalogue.map(definition => [definition.name,createProductTool(scope,binding,definition)]))
})
