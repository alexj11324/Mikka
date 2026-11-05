import { HOSTED_CHOICE, type BotModelCurrent, type BotModelMenu, type BotModelMenuGroup, type BotModelMenuOption } from '../../../lib/bot-model-menu-view'

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
    case 'shared': return `团队成员分享的${credential}`
  }
}
export function groupTag(group: ModelGroup) {
  if (group.kind === 'hosted') return '点数'
  if (group.kind === 'apiKey') return '按量'
  if (group.kind === 'shared' && group.owner) return `${group.owner}的 Key`
  return null
}
export function optionName(option: Pick<ModelOption, 'id' | 'modelId'>) {
  return option.id === HOSTED_CHOICE ? 'Mikka 默认' : option.modelId || '未知模型'
}
export function modelMenuLabel(current: BotModelCurrent, _running = false) {
  return optionName(current)
}
export function modelSourceLabel(current: BotModelCurrent) {
  const metered = current.kind === 'apiKey' || current.kind === 'shared'
  const status = current.availability === 'checking' ? '待检查' : !current.available ? '不可用' : null
  return [optionName(current), current.credentialLabel, metered ? '按量' : null, current.fallback ? '已切换' : null, status].filter(Boolean).join(' · ')
}
export const modelMenuReadLabel = (busy: boolean) => busy ? '正在读取模型' : '模型加载失败，重试'
export function modelStatusLine(current: BotModelCurrent): string | null {
  const quota = current.quota
  if (quota) {
    const subscription = [providerName(quota.subscription), quota.plan].filter(Boolean).join(' ')
    const exhausted = `${subscription} 订阅额度用完`
    if (quota.fallback) return `${exhausted} · 下一条使用 ${current.credentialLabel || quota.fallback.keyName || quota.fallback.keyProvider} API Key（按 token 计费）`
    const reset = quota.resetsAt ? new Date(quota.resetsAt) : null
    return reset && Number.isFinite(reset.getTime()) ? `${exhausted} · ${reset.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 恢复` : exhausted
  }
  if (current.availability === 'checking') return `${optionName(current)} · 额度待检查`
  if (!current.available) return `${optionName(current)} 现在不可用，请更换模型或刷新。`
  return current.fallback ? `下一条使用 ${modelSourceLabel(current)}` : null
}
