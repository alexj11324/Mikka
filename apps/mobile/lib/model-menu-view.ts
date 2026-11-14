import { mobileMessages } from '@/lib/messages'
import { HOSTED_CHOICE, type BotModelCurrent, type BotModelMenu, type BotModelMenuGroup, type BotModelMenuOption } from '../../../lib/bot-model-menu-view'
const messages = mobileMessages

export { HOSTED_CHOICE }
export type ModelOption = BotModelMenuOption
export type ModelGroup = BotModelMenuGroup
export type ModelMenu = BotModelMenu

const providerName = (provider?: string) => provider === 'claude' ? 'Claude' : 'ChatGPT'
export function groupTitle(group: ModelGroup) {
  const credential = group.credentialLabel ? ` · ${group.credentialLabel}` : ''
  switch (group.kind) {
    case 'hosted': return 'Mikka'
    case 'subscription': return `${group.plan ? `${providerName(group.provider)} ${group.plan}` : providerName(group.provider)}${credential}`
    case 'apiKey': return `API Key${credential}`
    case 'shared': return `${messages.Coordinator.modelPicker.shared}${credential}`
  }
}
export function groupTag(group: ModelGroup) {
  if (group.kind === 'hosted') return group.hostedSource === 'cloud' ? messages.Coordinator.modelPicker.cloudCredits : group.hostedSource === 'self-hosted' ? messages.Coordinator.modelPicker.ownProvider : messages.Coordinator.modelPicker.credits
  if (group.kind === 'apiKey') return messages.Coordinator.modelPicker.metered
  if (group.kind === 'shared' && group.owner) return messages.Coordinator.modelPicker.sharedKey.replace('{name}', group.owner)
  return null
}
const BRANDS: Record<string, string> = { gpt: 'GPT', claude: 'Claude', deepseek: 'DeepSeek', kimi: 'Kimi', gemini: 'Gemini', qwen: 'Qwen', glm: 'GLM' }
/**
 * A model id as people read it (#1386): 「gpt-6-luna」 is GPT-6 Luna, 「claude-opus-5-5」 Claude Opus 5.5,
 * 「deepseek-flash」 DeepSeek Flash. Version digits split by hyphens join with a point; GPT keeps its hyphen.
 * An id that is not in this shape (spaces, capitals already) is shown as it is.
 */
export function modelDisplayName(id: string) {
  if (!/^[a-z0-9][a-z0-9.\-_]*$/.test(id)) return id
  const parts: string[] = []
  for (const token of id.split(/[-_]/).filter(Boolean)) {
    const previous = parts.at(-1)
    // A date stamp (claude-sonnet-4-5-20250929) is not part of the version.
    if (/^\d{6,}$/.test(token)) continue
    if (/^\d+$/.test(token) && previous && /\d$/.test(previous) && !/^GPT-/.test(previous)) { parts[parts.length - 1] = `${previous}.${token}`; continue }
    // OpenAI's reasoning models are written lowercase (o3, o4-mini).
    if (/^o\d+$/.test(token) && !previous) { parts.push(token); continue }
    if (previous === 'GPT' && /^\d/.test(token)) { parts[parts.length - 1] = `GPT-${token}`; continue }
    parts.push(BRANDS[token] ?? (/^\d/.test(token) ? token : token[0].toUpperCase() + token.slice(1)))
  }
  return parts.join(' ')
}
export function optionName(option: Pick<ModelOption, 'id' | 'modelId'>) {
  return option.id === HOSTED_CHOICE ? messages.Coordinator.modelPicker.hosted : option.modelId ? modelDisplayName(option.modelId) : messages.Coordinator.modelPicker.unknownModel
}
export function modelMenuLabel(current: BotModelCurrent, _running = false) {
  return optionName(current)
}
export function modelSourceLabel(current: BotModelCurrent) {
  const metered = current.kind === 'apiKey' || current.kind === 'shared'
  const status = current.availability === 'checking' ? messages.Coordinator.modelPicker.checking : !current.available ? messages.Coordinator.modelPicker.unavailable : null
  return [optionName(current), current.hostedSource === 'cloud' ? messages.Coordinator.modelPicker.cloudCredits : null, current.credentialLabel, metered ? messages.Coordinator.modelPicker.metered : null, current.fallback ? messages.Coordinator.modelPicker.fallback : null, status].filter(Boolean).join(' · ')
}
export const modelMenuReadLabel = (busy: boolean) => busy ? messages.Common.loading : messages.Coordinator.modelPicker.retryLoad
/**
 * The line above the composer, only when the next message will go differently (#1386): the subscription ran out
 * (what the next one uses, or when it comes back), the model cannot run (with 换模型), or the next one uses
 * another model. While the allowance is being checked, or all is well, nothing: the send itself checks, and a
 * failure says why on that message. The model's name is in the chip beside the composer, not here again.
 */
export type ModelStatus = { line: string; change: boolean }
export function modelStatusLine(current: BotModelCurrent): ModelStatus | null {
  const quota = current.quota
  if (quota) {
    const subscription = [providerName(quota.subscription), quota.plan].filter(Boolean).join(' ')
    const exhausted = `${subscription} 订阅额度用完`
    if (quota.fallback) return { line: `${exhausted}，下一条改用 ${current.credentialLabel || quota.fallback.keyName || quota.fallback.keyProvider} API Key（按 token 计费）`, change: false }
    const reset = quota.resetsAt ? new Date(quota.resetsAt) : null
    return { line: reset && Number.isFinite(reset.getTime()) ? `${exhausted}，${reset.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 恢复` : exhausted, change: true }
  }
  if (current.availability === 'checking') return null
  if (!current.available) return { line: '这个模型现在用不了', change: true }
  return current.fallback ? { line: `下一条改用 ${[optionName(current), current.credentialLabel, current.kind === 'apiKey' || current.kind === 'shared' ? '按量' : null].filter(Boolean).join(' · ')}`, change: false } : null
}
