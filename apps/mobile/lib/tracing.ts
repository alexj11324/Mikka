import Constants from 'expo-constants'
import * as Application from 'expo-application'
import { mobileTraceFetch, mobileTraceHeaders as requestHeaders } from '@mikka/protocol/trace-context'
import { API_URL } from './config'

const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version

/** Only Mikka requests get these headers; no client spans, user IDs or session data are exported. */
export const mobileTraceHeaders = () => requestHeaders(version)
export const mobileFetch = mobileTraceFetch(API_URL, version)
