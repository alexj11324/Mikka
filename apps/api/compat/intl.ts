import { createTranslator, type NamespaceKeys, type NestedKeyOf } from 'use-intl/core'
import { currentRequestScope, requireRequestScope } from '../src/context'
import { currentDesktopLocale } from '../../../lib/desktop-rpc/session'
import en from '../../../messages/en.json'
import zh from '../../../messages/zh-CN.json'

const valid = (locale: unknown): 'en' | 'zh-CN' => locale === 'en' ? 'en' : 'zh-CN'
export async function getLocale(): Promise<'en' | 'zh-CN'> { return valid(currentDesktopLocale() ?? currentRequestScope()?.locale) }
export function setRequestLocale(locale: string): void { requireRequestScope().locale = valid(locale) }
export async function getMessages(options?: { locale?: string }) { return valid(options?.locale ?? await getLocale()) === 'en' ? en : zh }
type Messages = typeof en
type Namespace = NamespaceKeys<Messages, NestedKeyOf<Messages>>
export async function getTranslations<N extends Namespace = never>(input?: N | { locale?: string; namespace?: N }) {
  const options = typeof input === 'string' ? { namespace: input } : input
  const locale = valid(options?.locale ?? await getLocale())
  return createTranslator<Messages, N>({ locale, messages: locale === 'en' ? en : zh, namespace: options?.namespace })
}
export function getRequestConfig<T>(configuration: (params: { requestLocale: Promise<string | undefined> }) => T): typeof configuration { return configuration }
