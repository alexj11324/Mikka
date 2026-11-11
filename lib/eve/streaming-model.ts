import type { LanguageModel } from 'ai'

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
type Generated = Awaited<ReturnType<Model['doGenerate']>>
type Text = Extract<Generated['content'][number], { type: 'text' | 'reasoning' }>

/** eve's compaction may request generate; subscriptions retain their one streaming transport. */
export function streamingModel(model: Model): Model {
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doStream: options => model.doStream(options),
    async doGenerate(options): Promise<Generated> {
      const result = await model.doStream(options)
      const content: Generated['content'] = []
      const blocks = new Map<string, Text>()
      const warnings: Generated['warnings'] = []
      let finish: Pick<Generated, 'usage' | 'finishReason' | 'providerMetadata'> | undefined
      let response: Generated['response'] = result.response
      const reader = result.stream.getReader()
      try {
        for (;;) {
          options.abortSignal?.throwIfAborted()
          const { done, value: part } = await reader.read()
          if (done) break
          switch (part.type) {
            case 'error': throw new Error('subscription_generation_failed', { cause: part.error })
            case 'stream-start': warnings.push(...part.warnings); break
            case 'response-metadata': {
              const { type: _, ...metadata } = part
              response = { ...response, ...metadata }
              break
            }
            case 'finish': finish = { usage: part.usage, finishReason: part.finishReason, providerMetadata: part.providerMetadata }; break
            case 'text-start':
            case 'text-delta':
            case 'text-end':
            case 'reasoning-start':
            case 'reasoning-delta':
            case 'reasoning-end': {
              const block: Text = blocks.get(part.id) ?? (part.type.startsWith('reasoning-') ? { type: 'reasoning', text: '' } : { type: 'text', text: '' })
              if (!blocks.has(part.id)) {
                blocks.set(part.id, block)
                content.push(block)
              }
              if ('delta' in part) block.text += part.delta
              if (part.providerMetadata) {
                for (const [provider, metadata] of Object.entries(part.providerMetadata)) {
                  block.providerMetadata = { ...block.providerMetadata, [provider]: { ...block.providerMetadata?.[provider], ...metadata } }
                }
              }
              if ('citations' in part && block.type === 'text') block.citations = part.citations
              break
            }
            case 'file':
            case 'reasoning-file':
            case 'custom':
            case 'source':
            case 'tool-call':
            case 'tool-result':
            case 'tool-approval-request': content.push(part); break
          }
        }
        options.abortSignal?.throwIfAborted()
        if (!finish) throw new Error('subscription_generation_failed')
        return { content, warnings, ...finish, request: result.request, response }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    },
  }
}
