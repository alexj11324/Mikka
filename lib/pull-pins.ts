import "server-only";
import type { Pool } from "pg";
import { z } from "zod";
import { githubPullRequestKey } from "./issue-metadata";

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
  database: Queryable,
  userId: string,
  raw: z.input<typeof pullPinsInput>,
): Promise<string[] | "pinLimit"> {
  const input = pullPinsInput.parse(raw);
  const keys = [...new Set(input.urls.map(githubPullRequestKey))];
  if (!input.pinned) {
    await database.query(
      `DELETE FROM pull_pins WHERE "userId"=$1 AND "workspaceId"=$2 AND "pullKey"=ANY($3::text[])`,
      [userId, input.workspaceId, keys],
    );
    return listPullPins(database, userId, input.workspaceId);
  }
  const { rowCount } = await database.query(
    `INSERT INTO pull_pins ("userId","workspaceId","pullKey")
      SELECT $1,$2,key FROM unnest($3::text[]) key
      WHERE (SELECT count(*) FROM pull_pins WHERE "userId"=$1 AND "workspaceId"=$2 AND NOT ("pullKey"=ANY($3::text[])))
        + cardinality($3::text[]) <= $4
    ON CONFLICT DO NOTHING`,
    [userId, input.workspaceId, keys, MAX_PULL_PINS],
  );
  const pins = await listPullPins(database, userId, input.workspaceId);
  if (!rowCount && !keys.every((key) => pins.includes(key))) return "pinLimit";
  return pins;
}
