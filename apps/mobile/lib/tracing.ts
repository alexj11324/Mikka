import Constants from 'expo-constants'
import * as Application from 'expo-application'
import { mobileTraceFetch, mobileTraceHeaders as requestHeaders } from '@mikka/protocol/trace-context'

export const mobileAppVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0'

/** Only Mikka requests get these headers; no client spans, user IDs or session data are exported. */
export const mobileTraceHeaders = () => requestHeaders(mobileAppVersion)
export const mobileFetchFor = (url: string) => mobileTraceFetch(url, mobileAppVersion)
