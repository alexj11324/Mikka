import { defineDynamic, defineTool } from 'eve/tools'
import { executionForSession } from '../../../../lib/eve/runtime'
import { productRpc, type ProductCatalogueEntry } from '../../../../lib/eve/product-rpc'

/** Product actions keep their existing ownership, billing and audit boundaries. */
export default defineDynamic(async ctx => {
  const { scope, execution } = await executionForSession(ctx)
  const binding = {sessionId:ctx.session.id,turnId:ctx.turn!.id,executionId:execution?.id}
  const {tools:catalogue} = await productRpc<{tools:ProductCatalogueEntry[]}>(scope,{...binding,operation:'catalogue'})
  return Object.fromEntries(catalogue.map(definition => {
    return [definition.name, defineTool({ description:definition.description,
      inputSchema: definition.inputSchema as never,
      async execute(input: unknown, toolContext) {
        return (await productRpc<{output:unknown}>(scope,{...binding,operation:'execute',name:definition.name,input,callId:toolContext.callId},toolContext.abortSignal)).output
      },
    })]
  }))
})
