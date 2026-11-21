import type { Pool } from 'pg'

/** One Slack thread of one person's Slack link (mikka_slack_members.link_id). */
export interface SlackThreadKey { linkId: string; channelId: string; threadTs: string }
type Query = Pick<Pool, 'query'>

/** A thread started with `bot=<alias>` goes on to that Bot; a later alias in the thread moves it. */
export async function rememberSlackThreadBot(query: Query, thread: SlackThreadKey, ownerId: string, botId: string): Promise<void> {
  await query.query(`INSERT INTO slack_thread_bots ("linkId","channelId","threadTs","ownerId","botId") VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT ("linkId","channelId","threadTs") DO UPDATE SET "botId"=EXCLUDED."botId","ownerId"=EXCLUDED."ownerId"`,
  [thread.linkId, thread.channelId, thread.threadTs, ownerId, botId])
}

/** The Bot a thread was routed to, while it is still the person's own live Bot in this workspace. */
export async function slackThreadBot(query: Query, thread: SlackThreadKey, ownerId: string, workspaceId: string): Promise<string | null> {
  const { rows: [row] } = await query.query<{ botId: string }>(`SELECT t."botId" FROM slack_thread_bots t JOIN bots b ON b.id=t."botId"
    WHERE t."linkId"=$1 AND t."channelId"=$2 AND t."threadTs"=$3 AND t."ownerId"=$4 AND b."ownerId"=$4 AND b."workspaceId"=$5 AND b."archivedAt" IS NULL`,
  [thread.linkId, thread.channelId, thread.threadTs, ownerId, workspaceId])
  return row?.botId ?? null
}
