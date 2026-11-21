import { defineDynamic, defineInstructions } from 'eve/instructions'

export default defineDynamic(async ctx => {
  const { instructionsForSession } = await import('../../../lib/eve/runtime')
  return defineInstructions({ content: await instructionsForSession(ctx) })
})
