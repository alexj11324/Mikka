import { createTranslator, type NamespaceKeys, type NestedKeyOf } from 'use-intl/core'
import { currentRequestScope, requireRequestScope } from '../../apps/api/src/context'
import { currentDesktopLocale } from '../desktop-rpc/session'
import en from '../../messages/en.json'
import zh from '../../messages/zh-CN.json'

/**
 * Server-side translations, reading the locale of the request in scope.
 *
 * `next-intl/server` existed for the same purpose; this module keeps the same
 * three call shapes (`getLocale`, `getMessages`, `getTranslations`) without the
 * framework, so server code has one entry point.
 */
const valid = (locale: unknown): 'en' | 'zh-CN' => locale === 'en' ? 'en' : 'zh-CN'

export async function getLocale(): Promise<'en' | 'zh-CN'> {
  return valid(currentDesktopLocale() ?? currentRequestScope()?.locale)
}

export function setRequestLocale(locale: string): void {
  requireRequestScope().locale = valid(locale)
}

export async function getMessages(options?: { locale?: string }) {
  return valid(options?.locale ?? await getLocale()) === 'en' ? en : zh
}

type Messages = typeof en
type Namespace = NamespaceKeys<Messages, NestedKeyOf<Messages>>

export async function getTranslations<N extends Namespace = never>(input?: N | { locale?: string; namespace?: N }) {
  const options = typeof input === 'string' ? { namespace: input } : input
  const locale = valid(options?.locale ?? await getLocale())
  return createTranslator<Messages, N>({ locale, messages: locale === 'en' ? en : zh, namespace: options?.namespace })
}

export function getRequestConfig<T>(configuration: (params: { requestLocale: Promise<string | undefined> }) => T): typeof configuration {
  return configuration
}

/** Build a translator outside a request, for a message rendered into a stored
 * payload (a Slack notice, a run summary). */
export { createTranslator }
