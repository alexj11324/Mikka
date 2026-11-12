-- Task/Run stored tenancy supersedes optional Team provenance. Retain the
-- original source fences and add the new identity fields for existing leases.
-- This is APP-only; Workspace mutations still fence through their locked
-- control-plane path and drain exact lease IDs after the outer WS transaction.
CREATE TRIGGER coding_review_task_workspace_update
  AFTER UPDATE OF "workspaceId","ownershipState" ON issues
  FOR EACH ROW WHEN (ROW(OLD."workspaceId",OLD."ownershipState")
    IS DISTINCT FROM ROW(NEW."workspaceId",NEW."ownershipState"))
  EXECUTE FUNCTION mikka_fence_coding_review('task','id','task_changed');

CREATE TRIGGER coding_review_run_workspace_update
  AFTER UPDATE OF "workspaceId" ON agent_runs
  FOR EACH ROW WHEN (OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId")
  EXECUTE FUNCTION mikka_fence_coding_review('run','id','run_changed');
