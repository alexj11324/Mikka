import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { createFactoryStore } from "./store";

// Preserve existing personal/workspace/team/deletion access rules on every operation.
export const factoryStore = createFactoryStore(
  pool,
  async (userId, issueId, tx) => {
    // Reuse the held transaction: a second pool checkout here can deadlock
    // concurrent operations when the application connection pool is full.
    await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
    return Boolean(await issueForUser(userId, issueId, false, drizzle(tx)));
  },
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
