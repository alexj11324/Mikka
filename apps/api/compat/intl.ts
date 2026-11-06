import { createTranslator } from 'use-intl/core'
import { currentRequestScope, requireRequestScope } from '../src/context'
import { currentDesktopLocale } from '../../../lib/desktop-rpc/session'
import en from '../../../messages/en.json'
import zh from '../../../messages/zh-CN.json'

const valid = (locale: unknown): 'en' | 'zh-CN' => locale === 'en' ? 'en' : 'zh-CN'
export async function getLocale(): Promise<'en' | 'zh-CN'> { return valid(currentDesktopLocale() ?? currentRequestScope()?.locale) }
export function setRequestLocale(locale: string): void { requireRequestScope().locale = valid(locale) }
export async function getMessages(options?: { locale?: string }) { return valid(options?.locale ?? await getLocale()) === 'en' ? en : zh }
export async function getTranslations(input?: string | { locale?: string; namespace?: string }) {
  const options = typeof input === 'string' ? { namespace: input } : input
  const locale = valid(options?.locale ?? await getLocale())
  return createTranslator({ locale, messages: (locale === 'en' ? en : zh) as Record<string, any>, namespace: options?.namespace })
}
export function getRequestConfig<T>(configuration: T): T { return configuration }
