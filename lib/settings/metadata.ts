import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'
import type { SettingSchemaEntry } from '@mikka/protocol/settings'

/** The API schema and client row search use the same canonical locale catalogues. */
export function settingMetadata(key: keyof typeof en.SettingsRegistry): Pick<SettingSchemaEntry, 'label' | 'keywords'> {
  const english = en.SettingsRegistry[key], chinese = zh.SettingsRegistry[key]
  return {
    label: { en: english.label, 'zh-CN': chinese.label },
    keywords: [...new Set([...english.keywords.split('|'), ...chinese.keywords.split('|')].map(word => word.trim()).filter(Boolean))],
  }
}
