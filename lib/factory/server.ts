import "server-only";
import { pool } from "@/lib/db";
import { issueForUser } from "@/lib/issue-access";
import { createFactoryStore } from "./store";

// Preserve existing personal/workspace/team/deletion access rules on every operation.
export const factoryStore = createFactoryStore(pool, async (userId, issueId) =>
  Boolean(await issueForUser(userId, issueId)),
);
