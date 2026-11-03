import { z } from 'zod'
import { harnessInfoSchema, harnessReportsModel } from '@mikka/protocol/harness'
import type { OrderEntry } from './model-order-plan'
const template = z.object({ templateId: z.string().regex(/^[A-Za-z0-9_-]+$/), models: z.array(harnessInfoSchema).max(4) }).strict()
export const cloudTemplateModelsSchema = z.object({
  version: z.literal(1), workerSha: z.string().regex(/^[a-f0-9]{40}$/),
  templates: z.object({ desktop: template, claude: template, codex: template }).strict(),
}).strict()
export type CloudModelState = 'ready' | 'cloudModelsUnknown' | 'cloudModelNotReported'
export function cloudTemplateModels(env: Record<string, string | undefined> = process.env) {
  try {
    const result = cloudTemplateModelsSchema.parse(JSON.parse(env.MIKKA_CLOUD_TEMPLATE_MODELS ?? ''))
    if (result.workerSha !== env.MIKKA_CLOUD_WORKER_SHA) return null
    for (const [kind, variable] of Object.entries({ desktop: 'E2B_BYO_COMPUTER_TEMPLATE', claude: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' }) as [keyof typeof result.templates, string][])
      if (result.templates[kind].templateId !== env[variable]) return null
    return result
  } catch { return null }
}
/** The model catalogue is measured on the exact image selected for this work. */
export function cloudModelSupport(entry: Pick<OrderEntry, 'harness' | 'model' | 'source'>, purpose: 'task' | 'desktop' = 'task', env: Record<string, string | undefined> = process.env): CloudModelState {
  const catalogue = cloudTemplateModels(env)
  if (!catalogue) return 'cloudModelsUnknown'
  const kind = purpose === 'desktop' ? 'desktop' : entry.harness === 'claude_code' ? 'claude' : 'codex'
  const harness = catalogue.templates[kind].models.find(info => info.harness === entry.harness && info.installed)
  if (!harness) return 'cloudModelNotReported'
  return entry.source.kind === 'api_key' || harnessReportsModel(harness, entry.model) === true ? 'ready' : 'cloudModelNotReported'
}
