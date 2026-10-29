import type { PoolClient } from "pg";
import type { FactoryTask } from "./approval-dependencies";
import { FactoryError } from "./approval-contract";
function fail(code: string): never {
  throw new FactoryError(code);
}

/** Actual authorized issue, originating event and frozen assignment. Read on
 * both sides of the model invocation; a changed instruction invalidates the
 * handle even if candidate scope/reports omit that instruction. */
export async function readFactoryPublicationRequirements(
  tx: PoolClient,
  task: FactoryTask,
  assignment: unknown,
) {
  const identity = task as FactoryTask & {
    botId?: unknown;
    sourceEventId?: unknown;
  };
  const {
    rows: [issue],
  } = await tx.query(
    'SELECT id,title,content,revision FROM issues WHERE id=$1 AND "userId"=$2 FOR SHARE',
    [task.issueId, task.userId],
  );
  const {
    rows: [source],
  } = await tx.query(
    'SELECT id,"userId","botId","issueId",kind,payload FROM coordinator_events WHERE id=$1 FOR SHARE',
    [identity.sourceEventId],
  );
  if (
    !issue ||
    typeof issue.title !== "string" ||
    !issue.content ||
    !Number.isSafeInteger(issue.revision) ||
    !source ||
    source.userId !== task.userId ||
    (source.issueId !== null && source.issueId !== task.issueId) ||
    source.kind !== "user_message" ||
    source.botId !== identity.botId ||
    !source.payload
  )
    fail("factoryEvidenceMismatch");
  return { issue, source, assignment };
}
