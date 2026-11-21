import { sql, type SQLWrapper } from 'drizzle-orm'

/** Admission and settlement are native facts. This compatibility read never
 * starts a turn, retries one, or infers failure from queue latency. */
export function nativePendingForChat(ownerId:string,botId:string|SQLWrapper) {
  return sql<boolean>`exists(select 1 from coordinator_messages np
    join coordinator_events ne on ne.id::text=np.message#>>'{mikkaUserEvent,id}'
      and ne."userId"=np."userId" and ne."botId"=np."botId" and ne.kind='user_message'
    where np."userId"=${ownerId} and np."botId"=${botId}::uuid
      and np.message->'mikkaEveAccepted'='true'::jsonb and ne."deliveredAt" is not null
      and not exists(select 1 from eve_turn_sources nt
        join eve_sessions ns on ns.session_id=nt.session_id and ns.owner_id=np."userId" and ns.bot_id=np."botId" and ns.surface='web'
        join eve_projection_receipts nr on nr.session_id=nt.session_id and nr.event_key=nt.turn_id
        where nt.source_event_id=ne.id))`
}
