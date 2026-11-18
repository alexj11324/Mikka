import type { DispatchNothingReason } from './model-dispatch'

/** Where a person gives an Agent a model: 设置 › 模型与订阅. */
export const MODEL_SETTINGS_HREF = '/settings?section=models'
export const AGENT_NAMES = { claude_code: 'Claude Code', codex: 'Codex' } as const

/** The named Agent has no model it can run: none in 优先使用的模型 and no
 * subscription or key offers one, or every one offered is unusable now. A
 * missing computer or cloud is a different problem. */
const NO_MODEL: ReadonlySet<DispatchNothingReason> = new Set<DispatchNothingReason>(['notOffered', 'noModels', 'unavailable', 'pickedUnavailable'])
export const agentHasNoModel = (reason: DispatchNothingReason) => NO_MODEL.has(reason)
