import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { createFactoryStore } from "./store";
import type { FactoryAuthorize } from "./store";
import { createFactoryCheckClaim } from "./checks";
import { factoryCheckGates } from "./checks";

// Preserve existing personal/workspace/team/deletion access rules on every operation.
const authorizeFactoryIssue: FactoryAuthorize = async (userId, issueId, tx) => {
  // Reuse the held transaction; another pool checkout can deadlock.
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
  return Boolean(await issueForUser(userId, issueId, false, drizzle(tx)));
};
export const factoryStore = createFactoryStore(
  pool,
  authorizeFactoryIssue,
  factoryCheckGates,
);
export const claimFactoryCheckRun = createFactoryCheckClaim(
  pool,
  authorizeFactoryIssue,
);

import { queueRun } from "@/lib/agent-runs";
import { createFactoryDispatch } from "./dispatch";
import { factoryDispatchDatabase } from "./transaction";
export const dispatchFactoryRun = createFactoryDispatch(
  pool,
  factoryStore,
  (tx, userId, input) => queueRun(userId, input, factoryDispatchDatabase(tx)),
);
import { createFactoryReconciler } from "./reconcile";
export const reconcileFactoryRuns = createFactoryReconciler(pool, factoryStore);
