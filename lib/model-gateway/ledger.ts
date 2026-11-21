import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import type { GatewayUsage } from './usage'

export interface ModelReceipt {
  messageId: string | null
  cost: number | null
  usage: (Omit<GatewayUsage, 'cacheReadTokens' | 'cacheWriteTokens'> & {
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
  }) | null
  generationId?: string
}

export async function recordExternalModelUsage(query: Pick<typeof db, 'execute'>, receipt: ModelReceipt & {
  id: string
  workspaceId: string
  ownerId: string
  runId: string
  threadId: string | null
  model: string
  source: 'api_key' | 'subscription'
}) {
  await query.execute(sql`INSERT INTO hosted_usage (id,"workspaceId","usageWorkspaceId","executionOwnerId","actorId",
    "usageRunId","usageThreadId","usageMessageId",model,"billingSource",state,"costMicroUsd","inputTokens","outputTokens",
    "cacheReadTokens","cacheWriteTokens","generationId","settledAt")
    VALUES (${receipt.id},${receipt.workspaceId},${receipt.workspaceId},${receipt.ownerId},${receipt.ownerId},
      ${receipt.runId},${receipt.threadId},${receipt.messageId},${receipt.model},${receipt.source},'settled',
      ${receipt.cost},${receipt.usage?.inputTokens ?? 0},${receipt.usage?.outputTokens ?? 0},
      ${receipt.usage?.cacheReadTokens ?? null},${receipt.usage?.cacheWriteTokens ?? null},
      ${receipt.generationId ?? null},now())
    ON CONFLICT (id) DO NOTHING`)
}
