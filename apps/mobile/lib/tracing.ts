import Constants from 'expo-constants'
import * as Application from 'expo-application'
import { mobileTraceFetch, mobileTraceHeaders as requestHeaders } from '@mikka/protocol/trace-context'
import { CLIENT_KIND_HEADER, CLIENT_VERSION_HEADER, HOSTED_API_HEADERS, hostedApiUpgrade } from '@mikka/protocol/version'
import { requireMobileUpdate } from './startup'

export const mobileAppVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0'

/** Only Mikka requests get these headers; no client spans, user IDs or session data are exported. */
export const mobileTraceHeaders = () => ({ ...requestHeaders(mobileAppVersion),
  [CLIENT_KIND_HEADER]: 'mobile', [CLIENT_VERSION_HEADER]: mobileAppVersion, ...HOSTED_API_HEADERS })
export const mobileFetchFor = (url: string): typeof fetch => {
  const traced = mobileTraceFetch(url, mobileAppVersion)
  const base = new URL(url), prefix = `${base.pathname.replace(/\/$/, '')}/api/`
  return async (input, init) => {
    let target: URL
    try { target = new URL(input instanceof Request ? input.url : String(input), url) }
    catch { return traced(input, init) }
    if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) return traced(input, init)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    for (const [key, value] of Object.entries({ [CLIENT_KIND_HEADER]: 'mobile', [CLIENT_VERSION_HEADER]: mobileAppVersion, ...HOSTED_API_HEADERS })) headers.set(key, value)
    const response = await traced(input, { ...init, headers })
    if (response.status === 426 && hostedApiUpgrade(await response.clone().json().catch(() => null))) requireMobileUpdate(url)
    return response
  }
}
