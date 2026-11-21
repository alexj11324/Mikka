import { slackRunOriginRef, telegramRunOriginRef, type ResolvedRunOrigin } from '../run-origin'

/** Evidence comes from the owned source event, never model/tool arguments. */
export function eveRunOrigin(surface:'web'|'slack',payload:Record<string,unknown>|undefined,scheduledRead:boolean):ResolvedRunOrigin {
  if(scheduledRead)return {origin:'schedule',originRef:null}
  if(surface==='slack') {
    const slack=payload?.slack
    const entry=slack&&typeof slack==='object'&&!Array.isArray(slack)?slack as Record<string,unknown>:{}
    return {origin:'slack',originRef:slackRunOriginRef({team_id:entry.teamId,channel:entry.channelId,thread_ts:entry.threadTs,ts:entry.ts})}
  }
  const originRef=telegramRunOriginRef(payload?.telegram)
  return {origin:originRef?'telegram':'web',originRef}
}
