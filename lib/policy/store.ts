import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { appendAudit, transaction } from "../audit/store";
import {
  admitModel,
  documentSchema,
  PolicyError,
  resolvePolicy,
  type EffectivePolicy,
  type ModelRoute,
  type PolicyContext,
} from "./contract";
import type { PolicySigner, SignedPolicy } from "./signing";

export type PolicyBinding = {
  signed: SignedPolicy;
  revoked: boolean;
  effective: EffectivePolicy;
};
export class PolicyStore {
  constructor(
    readonly pool: Pool,
    readonly signer: PolicySigner,
  ) {}
  async member(
    tx: PoolClient,
    workspaceId: string,
    userId: string,
    admin = false,
  ) {
    const member = (
      await tx.query(
        `SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,
        [workspaceId, userId],
      )
    ).rows[0];
    if (!member || (admin && member.role !== "admin"))
      throw new PolicyError("policyAccessDenied", 403);
  }
  async publish(
    workspaceId: string,
    userId: string,
    expectedVersion: number,
    input: unknown,
    rollbackOf?: number,
  ) {
    return transaction(this.pool, async (tx) => {
      // Same workspace lock covers initial publication, admission and all subsequent versions.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `organization-policy:${workspaceId}`,
      ]);
      await this.member(tx, workspaceId, userId, true);
      const head = (
        await tx.query(
          "SELECT version FROM organization_policy_heads WHERE workspace_id=$1 FOR UPDATE",
          [workspaceId],
        )
      ).rows[0];
      if ((head?.version ?? 0) !== expectedVersion)
        throw new PolicyError("policyVersionConflict");
      if (rollbackOf !== undefined) {
        const target = (
          await tx.query(
            "SELECT signed FROM organization_policy_versions WHERE workspace_id=$1 AND version=$2",
            [workspaceId, rollbackOf],
          )
        ).rows[0];
        if (!target) throw new PolicyError("policyVersionNotFound", 404);
        const verified = this.signer.verify(target.signed);
        if (
          verified.payload.workspaceId !== workspaceId ||
          verified.payload.version !== rollbackOf
        )
          throw new PolicyError("policyScopeMismatch", 403);
        input = verified.payload.document;
      }
      const document = documentSchema.parse(input);
      if (
        !document.layers.some(
          (l) => l.scope === "workspace" && l.id === workspaceId,
        )
      )
        throw new PolicyError("policyScopeMismatch", 422);
      for (const layer of document.layers) {
        if (layer.scope === "workspace") continue;
        const query =
          layer.scope === "team"
            ? `SELECT 1 FROM mikka_teams WHERE id::text=$1 AND "workspaceId"=$2`
            : layer.scope === "project"
              ? `SELECT 1 FROM mikka_team_projects WHERE "projectId"::text=$1 AND "workspaceId"=$2`
              : `SELECT 1 FROM mikka_workspace_members WHERE "userId"=$1 AND "workspaceId"=$2 AND status='active'`;
        if (!(await tx.query(query, [layer.id, workspaceId])).rowCount)
          throw new PolicyError("policyScopeMismatch", 422);
      }
      const version = expectedVersion + 1;
      const signed = this.signer.sign(workspaceId, version, document);
      await tx.query(
        "INSERT INTO organization_policy_heads(workspace_id,version) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET version=EXCLUDED.version, updated_at=now()",
        [workspaceId, version],
      );
      await tx.query(
        "INSERT INTO organization_policy_versions(workspace_id,version,signed,actor_id,rollback_of) VALUES($1,$2,$3,$4,$5)",
        [workspaceId, version, signed, userId, rollbackOf ?? null],
      );
      await appendAudit(tx, workspaceId, {
        actorId: userId,
        actorType: "human",
        resourceId: `${workspaceId}:${version}`,
        action: "policy.published",
        outcome: "success",
        reason: rollbackOf === undefined ? "published" : "rollback",
        requestId: randomUUID(),
      });
      return signed;
    });
  }
  async read(workspaceId: string, userId: string, version?: number) {
    return transaction(this.pool, async (tx) => {
      await this.member(tx, workspaceId, userId);
      const row = (
        await tx.query(
          "SELECT v.signed, v.version FROM organization_policy_heads h LEFT JOIN organization_policy_versions v ON v.workspace_id=h.workspace_id AND v.version=COALESCE($2,h.version) WHERE h.workspace_id=$1",
          [workspaceId, version ?? null],
        )
      ).rows[0];
      if (!row) return null;
      if (!row.signed) {
        if (version === undefined)
          throw new PolicyError("policyVersionUnavailable", 503);
        return null;
      }
      const signed = this.signer.verify(row.signed);
      if (
        signed.payload.workspaceId !== workspaceId ||
        signed.payload.version !== row.version
      )
        throw new PolicyError("policyScopeMismatch", 403);
      return signed;
    });
  }
  async contexts(
    tx: PoolClient,
    userId: string,
    workspaceId?: string,
    issueId?: string,
  ): Promise<PolicyContext[]> {
    const links = issueId
      ? (
          await tx.query(
            'SELECT "workspaceId", "teamId" FROM mikka_team_issues WHERE "issueId"=$1',
            [issueId],
          )
        ).rows
      : [];
    if (links.length) {
      if (workspaceId && workspaceId !== links[0].workspaceId)
        throw new PolicyError("policyScopeMismatch", 403);
      workspaceId = links[0].workspaceId;
    }
    if (workspaceId) await this.member(tx, workspaceId, userId);
    // Without a trusted tenant, intersect all enrolled memberships. Omitting scope cannot bypass policy.
    const memberships = workspaceId
      ? [{ workspaceId }]
      : (
          await tx.query(
            `SELECT m."workspaceId" FROM mikka_workspace_members m WHERE m."userId"=$1 AND m.status='active' ORDER BY m."workspaceId"`,
            [userId],
          )
        ).rows;
    const contexts: PolicyContext[] = [];
    for (const m of memberships) {
      const teams = (
        await tx.query(
          `SELECT t.id FROM mikka_teams t JOIN mikka_team_members m ON m."teamId"=t.id WHERE t."workspaceId"=$1 AND m."userId"=$2`,
          [m.workspaceId, userId],
        )
      ).rows.map((r) => r.id as string);
      if (links[0]?.teamId && !teams.includes(links[0].teamId))
        teams.push(links[0].teamId);
      const projects = issueId
        ? (
            await tx.query(
              `SELECT DISTINCT p.id FROM workspace_projects p JOIN mikka_team_projects t ON t."projectId"=p.id WHERE t."workspaceId"=$1 AND p."issueIds" ? $2`,
              [m.workspaceId, issueId],
            )
          ).rows.map((r) => r.id as string)
        : [];
      contexts.push({
        workspaceId: m.workspaceId,
        userId,
        teamIds: teams,
        projectIds: projects,
      });
    }
    return contexts.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  }
  async bindings(
    tx: PoolClient,
    userId: string,
    workspaceId?: string,
    issueId?: string,
    includeRevoked = false,
  ): Promise<PolicyBinding[]> {
    const contexts = await this.contexts(tx, userId, workspaceId, issueId);
    const bindings: PolicyBinding[] = [];
    for (const context of contexts) {
      await tx.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        [`organization-policy:${context.workspaceId}`],
      );
      const row = (
        await tx.query(
          "SELECT h.version, v.signed FROM organization_policy_heads h LEFT JOIN organization_policy_versions v USING(workspace_id,version) WHERE h.workspace_id=$1",
          [context.workspaceId],
        )
      ).rows[0];
      if (!row) continue;
      if (!row.signed) throw new PolicyError("policyVersionUnavailable", 503);
      const signed = this.signer.verify(row.signed);
      if (
        signed.payload.workspaceId !== context.workspaceId ||
        signed.payload.version !== row.version
      )
        throw new PolicyError("policyScopeMismatch", 403);
      const revoked = signed.payload.document.state === "revoked";
      if (revoked && !includeRevoked)
        throw new PolicyError("policyRevoked", 403);
      bindings.push({
        signed,
        revoked,
        effective: resolvePolicy(
          { ...signed.payload.document, state: "enforce" },
          context,
        ),
      });
    }
    return bindings;
  }
  async current(userId: string, workspaceId?: string, issueId?: string) {
    return transaction(this.pool, (tx) =>
      this.bindings(tx, userId, workspaceId, issueId),
    );
  }
  async checkModel(userId: string, route: ModelRoute, workspaceId?: string) {
    return transaction(this.pool, async (tx) => {
      const bindings = await this.bindings(tx, userId, workspaceId);
      for (const b of bindings) admitModel(b.effective, route);
      return bindings;
    });
  }
  private async denyExecution(
    userId: string,
    runId: string,
    issueId?: string,
    workspaceId?: string,
    tool = false,
  ) {
    const result = await transaction(this.pool, async (tx) => {
      const bindings = await this.bindings(
        tx,
        userId,
        workspaceId,
        issueId,
        true,
      );
      if (!bindings.length) return null;
      const reason = bindings.some((b) => b.revoked)
        ? "policyRevoked"
        : tool
          ? "toolEnforcementUnavailable"
          : "workerEnforcementUnavailable";
      for (const b of bindings)
        await appendAudit(tx, b.signed.payload.workspaceId, {
          actorId: userId,
          actorType: tool ? "system" : "worker",
          resourceId: runId,
          ...(tool ? {} : { runId }),
          action: tool ? "policy.tool" : "policy.worker",
          outcome: "denied",
          reason,
          requestId: randomUUID(),
        });
      return reason;
    });
    if (result)
      throw new PolicyError(result, result === "policyRevoked" ? 403 : 409);
  }
  async denyWorker(
    userId: string,
    runId: string,
    issueId?: string,
    workspaceId?: string,
  ) {
    return this.denyExecution(userId, runId, issueId, workspaceId);
  }
  async denyTool(userId: string, workspaceId?: string) {
    return this.denyExecution(
      userId,
      "unscoped-tool",
      undefined,
      workspaceId,
      true,
    );
  }
}
