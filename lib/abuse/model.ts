import 'server-only'
import { randomUUID } from 'node:crypto'
import { gateway, type LanguageModel } from 'ai'
import { checkAbuseAlerts } from './alerts'
import { canUseMikkaPaid, hostedUsage } from './runtime'
import {
  gatewayCost,
  HOSTED_CALL_TIMEOUT_MS,
  PaidResourceError,
} from './policy'
type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>
/** Every SDK tool step reaches this model boundary, including compaction. */
export async function hostedModel(
  workspaceId: string,
  modelId: string,
  provider?: Model,
): Promise<Model> {
  await canUseMikkaPaid(workspaceId)
  const model = provider ?? gateway(modelId)
  const reserve = async (
    id: string,
    args: Parameters<Model['doGenerate']>[0],
  ) => {
    // Upper-bound text input tokens by UTF-8 bytes, output by an enforced token
    // limit. Include an image/file token cushion without changing subscription calls.
    const promptBytes = Buffer.byteLength(
      JSON.stringify({ prompt: args.prompt, tools: args.tools }),
    )
    if (promptBytes > 16 * 1024 * 1024)
      throw new PaidResourceError('usage_cost_unavailable')
    const files = args.prompt.reduce(
      (count, message) =>
        count +
        (typeof message.content === 'string'
          ? 0
          : message.content.filter(
              (part) => part.type === 'file' || part.type === 'reasoning-file',
            ).length),
      0,
    )
    const entry = (await gateway.getAvailableModels()).models.find(
      (row) => row.id === modelId,
    )
    if (!entry?.pricing) throw new PaidResourceError('usage_cost_unavailable')
    const prices = entry.pricing
    const input = Math.max(
      ...[
        prices.input,
        prices.cachedInputTokens ?? '0',
        prices.cacheCreationInputTokens ?? '0',
      ].map(Number),
    )
    const output = Number(prices.output)
    if (![input, output].every((n) => Number.isFinite(n) && n >= 0))
      throw new PaidResourceError('usage_cost_unavailable')
    const maximum = Math.max(
      1,
      Math.ceil(
        ((promptBytes + files * 128_000) * input + 4096 * output) * 1e6 * 1.1,
      ),
    )
    await hostedUsage.reserve(workspaceId, modelId, id, process.env, maximum)
    await checkAbuseAlerts()
  }
  const options = (value: Parameters<Model['doGenerate']>[0]) => ({
    ...value,
    maxOutputTokens: Math.min(value.maxOutputTokens ?? 4096, 4096),
    abortSignal: AbortSignal.any([
      AbortSignal.timeout(HOSTED_CALL_TIMEOUT_MS),
      ...(value.abortSignal ? [value.abortSignal] : []),
    ]),
  })
  return new Proxy(model, {
    get(target, key) {
      if (key === 'doGenerate')
        return async (args: Parameters<Model['doGenerate']>[0]) => {
          const id = randomUUID()
          await reserve(id, args)
          try {
            const result = await target.doGenerate(options(args))
            const cost = gatewayCost(result.providerMetadata)
            await hostedUsage.settle(
              id,
              cost,
              result.usage.inputTokens.total ?? 0,
              result.usage.outputTokens.total ?? 0,
            )
            await checkAbuseAlerts()
            if (cost === null)
              throw new PaidResourceError('usage_cost_unavailable')
            return result
          } catch (error) {
            await hostedUsage.settle(id, null)
            throw error
          }
        }
      if (key === 'doStream')
        return async (args: Parameters<Model['doStream']>[0]) => {
          const id = randomUUID()
          await reserve(id, args)
          try {
            const result = await target.doStream(options(args))
            let finished = false
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream({
                  async transform(chunk, controller) {
                    if (chunk.type === 'finish') {
                      finished = true
                      const cost = gatewayCost(chunk.providerMetadata)
                      await hostedUsage.settle(
                        id,
                        cost,
                        chunk.usage.inputTokens.total ?? 0,
                        chunk.usage.outputTokens.total ?? 0,
                      )
                      await checkAbuseAlerts()
                      if (cost === null)
                        throw new PaidResourceError('usage_cost_unavailable')
                    }
                    controller.enqueue(chunk)
                  },
                  async flush() {
                    if (!finished) await hostedUsage.settle(id, null)
                  },
                }),
              ),
            }
          } catch (error) {
            await hostedUsage.settle(id, null)
            throw error
          }
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
