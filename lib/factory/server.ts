import "server-only";
import { pool, withDatabaseClient } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { createFactoryStore } from "./store";
import { FactoryError } from "./contract";

export function factoryRoutingEnabled() {
  return process.env.MIKKA_FACTORY_ROUTING_ENABLED === "1";
}
export function factoryForBot(botId: string | null) {
  if (!factoryRoutingEnabled())
    throw new FactoryError("factoryRoutingUnavailable");
  return createFactoryStore(
    pool,
    async (owner, issue, tx) =>
      withDatabaseClient(tx, async () => Boolean(await issueForUser(owner, issue))),
    botId,
  );
}
/** References are host records, never model-supplied provenance or approval. */
export async function factoryRequestSource(
  userId: string,
  botId: string | null,
  sourceEventId?: string,
) {
  if (!factoryRoutingEnabled())
    throw new FactoryError("factoryRoutingUnavailable");
  const { rows } = await pool.query(
    `SELECT e.id,e."createdAt",e.payload->>'text' AS text FROM coordinator_events e WHERE e."userId"=$1 AND e."botId" IS NOT DISTINCT FROM $2::uuid AND e.kind='user_message' AND e."issueId" IS NULL AND ($3::uuid IS NULL OR e.id=$3) AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$2 AND b."ownerId"=$1)) ORDER BY e."createdAt" DESC,e.id DESC LIMIT 20`,
    [userId, botId, sourceEventId ?? null],
  );
  if (sourceEventId && rows.length !== 1)
    throw new FactoryError("factorySourceMismatch");
  return rows;
}
