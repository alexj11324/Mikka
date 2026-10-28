import type { LanguageModel } from 'ai'
import {
  authorizeSubscriptionUse,
  type SubscriptionAccess,
  type SubscriptionUse,
} from '@mikka/protocol/subscription'

export interface SubscriptionModelBackend {
  // Server-owned implementation. Never populated from request-supplied URLs,
  // credentials or a browser's assertion of provider approval.
  access(): Promise<SubscriptionAccess>
  model(modelId: string): Promise<Exclude<LanguageModel, string>>
}

/** Model seam for Mikka's existing AI SDK loop; no second agent harness. */
export async function resolveSubscriptionModel(
  use: SubscriptionUse,
  modelId: string,
  backend: SubscriptionModelBackend,
  clock: () => number = Date.now,
): Promise<Exclude<LanguageModel, string>> {
  const check = async () => authorizeSubscriptionUse({ ...use, execution: 'model' }, await backend.access(), clock())
  await check()
  const model = await backend.model(modelId)
  // streamText can invoke a model repeatedly for tool steps. Check each call,
  // so reconnect/disconnect does not leave a cached model authorized forever.
  return new Proxy(model, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if ((property === 'doGenerate' || property === 'doStream') && typeof value === 'function') {
        return async (...args: unknown[]) => { await check(); return Reflect.apply(value, target, args) }
      }
      return value
    },
  })
}
