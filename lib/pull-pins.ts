import "server-only";
import type { Pool } from "pg";
import { z } from "zod";
import { githubPullRequestKey } from "./issue-metadata";
import { withListOwnerLock } from "./list-owner-lock";

type Queryable = Pick<Pool, "query">;
/** Pins per person per workspace: far more than a list shows, few enough to read in one go. */
export const MAX_PULL_PINS = 200;
const pullUrl = z
  .string()
  .max(500)
  .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,9}\/?$/i);
export const pullPinsInput = z.strictObject({
  workspaceId: z.uuid(),
  urls: z.array(pullUrl).min(1).max(100),
  pinned: z.boolean(),
});

/** The person's pinned PRs in one workspace, as githubPullRequestKey values. The caller has authorized the workspace. */
export async function listPullPins(
  database: Queryable,
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const { rows } = await database.query<{ pullKey: string }>(
    `SELECT "pullKey" FROM pull_pins WHERE "userId"=$1 AND "workspaceId"=$2 ORDER BY "createdAt","pullKey" LIMIT $3`,
    [userId, workspaceId, MAX_PULL_PINS],
  );
  return rows.map((row) => row.pullKey);
}

/** Pins or unpins PRs; 'pinLimit' when pinning would pass MAX_PULL_PINS. Returns the pins after the change. */
export async function setPullPins(
  database: Pick<Pool, "connect">,
  userId: string,
  raw: z.input<typeof pullPinsInput>,
): Promise<string[] | "pinLimit"> {
  const input = pullPinsInput.parse(raw);
  const keys = [...new Set(input.urls.map(githubPullRequestKey))];
  // The limit is counted under the person's own lock: two tabs pinning at once cannot both pass it.
  return withListOwnerLock(database, ["pull_pins", userId, input.workspaceId], async (tx) => {
    if (!input.pinned) {
      await tx.query(
        `DELETE FROM pull_pins WHERE "userId"=$1 AND "workspaceId"=$2 AND "pullKey"=ANY($3::text[])`,
        [userId, input.workspaceId, keys],
      );
      return listPullPins(tx, userId, input.workspaceId);
    }
    const { rows: [held] } = await tx.query<{ others: number }>(
      `SELECT count(*)::int AS others FROM pull_pins WHERE "userId"=$1 AND "workspaceId"=$2 AND NOT ("pullKey"=ANY($3::text[]))`,
      [userId, input.workspaceId, keys],
    );
    if (held.others + keys.length > MAX_PULL_PINS) return "pinLimit" as const;
    await tx.query(
      `INSERT INTO pull_pins ("userId","workspaceId","pullKey") SELECT $1,$2,key FROM unnest($3::text[]) key ON CONFLICT DO NOTHING`,
      [userId, input.workspaceId, keys],
    );
    return listPullPins(tx, userId, input.workspaceId);
  });
}
