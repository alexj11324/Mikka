import chineseMessages from '@/messages/zh-CN.json'
import englishMessages from '@/messages/en.json'

export type AgentCopy = { [Key in keyof typeof chineseMessages.AgentCopy]: string }

export const defaultAgentCopy: AgentCopy = chineseMessages.AgentCopy

export function getAgentCopy(locale: string): AgentCopy {
  return locale === 'en' ? englishMessages.AgentCopy : chineseMessages.AgentCopy
}
