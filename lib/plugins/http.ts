import { z } from 'zod'
import { PluginError } from './contracts'
import { SecretsKeyMissingError } from '@/lib/secrets/crypto'

const headers = { 'Cache-Control': 'private, no-store' }
export async function pluginResponse(work: () => Promise<unknown>, status = 200) {
  try { return Response.json(await work(), { status, headers }) }
  catch (error) {
    const code = error instanceof PluginError ? error.code : error instanceof SecretsKeyMissingError ? 'pluginCredentialsUnavailable' : 'pluginsUnavailable'
    return Response.json({ error: code }, { status: error instanceof PluginError ? error.status : 503, headers })
  }
}

export async function pluginBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  // Bound before JSON parsing; auth values must never enter generic log data.
  const reader = request.body?.getReader()
  if (!reader) throw new PluginError('invalidPluginInput', 400)
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_000) throw new PluginError('pluginInputTooLarge', 413)
      chunks.push(value)
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!parsed.success) throw new PluginError('invalidPluginInput', 400)
    return parsed.data
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('invalidPluginInput', 400)
  } finally { void reader.cancel().catch(() => {}) }
}
