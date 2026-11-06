import { hasLocale } from 'next-intl'
import { getRequestConfig } from 'next-intl/server'
import { currentDesktopLocale } from '@/lib/desktop-rpc/session'

import { routing } from './routing'

const loaders = {
  'zh-CN': () => import('../messages/zh-CN.json'),
  en: () => import('../messages/en.json'),
} as const

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = currentDesktopLocale() ?? await requestLocale
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale
  return { locale, messages: (await loaders[locale]()).default }
})
