import chineseMessages from '../../../messages/zh-CN.json'
import englishMessages from '../../../messages/en.json'

/** Device language is read at launch, including an iOS per-app language choice. */
const deviceLocale = Intl.DateTimeFormat().resolvedOptions().locale
export const mobileLocale = deviceLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'

export function getMobileMessages(locale: string) {
  return locale.toLowerCase().startsWith('zh') ? chineseMessages : englishMessages
}

export const mobileMessages = getMobileMessages(mobileLocale)
