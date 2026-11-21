import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  MAX_SAVED_VIEWS,
  saveViewInput,
  type SaveViewInput,
  type SavedView,
  type SavedViewScope,
} from "./saved-views";
import { withListOwnerLock } from "./list-owner-lock";

type Queryable = Pick<Pool, "query">;
type Row = {
  id: string;
  scope: SavedViewScope;
  name: string;
  filters: Record<string, unknown>;
  createdAt: Date;
};
const view = (row: Row): SavedView => ({
  id: row.id,
  scope: row.scope,
  name: row.name,
  filters: row.filters,
  createdAt: row.createdAt.toISOString(),
});

/** The person's own views of one list, oldest first. The caller has authorized the workspace. */
export async function listSavedViews(
  database: Queryable,
  ownerId: string,
  workspaceId: string,
  scope: SavedViewScope,
): Promise<SavedView[]> {
  const { rows } = await database.query<Row>(
    `SELECT id,scope,name,filters,"createdAt" FROM saved_views
      WHERE "ownerId"=$1 AND "workspaceId"=$2 AND scope=$3 ORDER BY "createdAt",id LIMIT $4`,
    [ownerId, workspaceId, scope, MAX_SAVED_VIEWS],
  );
  return rows.map(view);
}

/**
 * Saves a view under its name: the same name replaces that view's filters. Null when the list
 * already holds MAX_SAVED_VIEWS other views.
 */
export async function saveView(
  database: Pick<Pool, "connect">,
  ownerId: string,
  raw: SaveViewInput,
): Promise<SavedView | null> {
  const input = saveViewInput.parse(raw);
  // Counted under the person's own lock, as pins are: concurrent saves cannot pass MAX_SAVED_VIEWS.
  return withListOwnerLock(database, ["saved_views", ownerId, input.workspaceId], async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO saved_views (id,"ownerId","workspaceId",scope,name,filters)
        SELECT $1,$2,$3,$4,$5,$6::jsonb
        WHERE EXISTS (SELECT 1 FROM saved_views WHERE "ownerId"=$2 AND "workspaceId"=$3 AND scope=$4 AND name=$5)
          OR (SELECT count(*) FROM saved_views WHERE "ownerId"=$2 AND "workspaceId"=$3 AND scope=$4)<$7
      ON CONFLICT ("ownerId","workspaceId",scope,name) DO UPDATE SET filters=EXCLUDED.filters,"updatedAt"=now()
      RETURNING id,scope,name,filters,"createdAt"`,
      [
        randomUUID(),
        ownerId,
        input.workspaceId,
        input.scope,
        input.name,
        JSON.stringify(input.filters),
        MAX_SAVED_VIEWS,
      ],
    );
    return rows[0] ? view(rows[0]) : null;
  });
}

/** Deletes one of the person's own views; false when there was none. */
export async function deleteSavedView(
  database: Queryable,
  ownerId: string,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await database.query(
    `DELETE FROM saved_views WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3`,
    [id, ownerId, workspaceId],
  );
  return Boolean(rowCount);
}
