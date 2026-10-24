import { z } from "zod";
import type { Pool } from "pg";
import { browserTaskActionSchema, CredentialError } from "./contracts";
import type { CredentialBroker } from "./broker";
import { readIssueMetadata } from "../issue-metadata";

export type CredentialToolActor = {
  userId: string;
  runId?: string;
  taskId?: string | null;
};
const run = { runId: z.uuid().optional() };
const reference = { ...run, credentialRef: z.uuid() };
export const credentialToolDefinitions = {
  prepare_credential_request: {
    description:
      "Prepare a secure input request for a registered service on a live task/run. Returns only purpose/context and the authenticated submission endpoint. Never ask for or pass passwords, tokens or codes in chat/tool arguments. Coordinator callers must supply runId; run workers are bound automatically.",
    inputSchema: z
      .object({
        ...run,
        serviceId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        mode: z.enum(["api_header", "browser_login"]),
      })
      .strict(),
  },
  credential_status: {
    description:
      "Read non-secret credential state for this task using its opaque reference.",
    inputSchema: z.object(reference).strict(),
  },
  credential_use: {
    description:
      "Use a ready opaque credential reference in the registered controlled executor. No plaintext is returned. Do not call again after success; continue with credential_browser_action.",
    inputSchema: z.object(reference).strict(),
  },
  credential_browser_action: {
    description:
      "Continue this task in its authenticated controlled browser: named permitted page navigation, non-sensitive link click or bounded redacted business text. No URLs, selectors, JS, cookies or raw CDP.",
    inputSchema: z
      .object({ ...reference, action: browserTaskActionSchema })
      .strict(),
  },
  credential_finish: {
    description:
      "End this task credential/browser session and destroy its authentication state.",
    inputSchema: z.object(reference).strict(),
  },
} as const;
export type CredentialToolName = keyof typeof credentialToolDefinitions;

/** Runtime adapter shared by actual Coordinator and MCP registration. It never accepts plaintext. */
export class CredentialExecutionTools {
  constructor(
    private readonly options: {
      app: Pool;
      workspace: Pool;
      broker: CredentialBroker;
      basePath: string;
    },
  ) {}

  private async context(actor: CredentialToolActor, requestedRunId?: string) {
    const runId = actor.runId ?? requestedRunId;
    if (
      !runId ||
      (actor.runId && requestedRunId && actor.runId !== requestedRunId)
    )
      throw new CredentialError("credential_not_found", 404);
    const { rows } = await this.options.app.query(
      `SELECT r.id,r."issueId",r."sessionId",i.content FROM agent_runs r
      JOIN issues i ON i.id=r."issueId" JOIN devices d ON d.id=r."deviceId"
      WHERE r.id=$1 AND r."userId"=$2 AND i."userId"=$2 AND d."ownerId"=$2 AND d.enabled
      AND d."lastSeenAt">now()-interval '60 seconds' AND r.status IN ('running','waiting_input')
      AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now() AND r."sessionId" IS NOT NULL AND r."sessionId"<>''`,
      [runId, actor.userId],
    );
    const current = rows[0];
    if (
      !current ||
      (actor.taskId && actor.taskId !== current.issueId) ||
      readIssueMetadata(current.content).deletedAt
    )
      throw new CredentialError("credential_not_found", 404);
    const membership = await this.options.workspace.query(
      `SELECT t."workspaceId" FROM orvilo_team_issues t
      JOIN mikka_workspaces w ON w.id=t."workspaceId"
      JOIN mikka_workspace_members m ON m."workspaceId"=t."workspaceId" AND m."userId"=$2 AND m.status='active'
      WHERE t."issueId"=$1`,
      [current.issueId, actor.userId],
    );
    if (membership.rows.length !== 1)
      throw new CredentialError("credential_not_found", 404);
    return {
      runId,
      taskId: current.issueId as string,
      workspaceId: membership.rows[0].workspaceId as string,
      executionSession: current.sessionId as string,
    };
  }

  async execute(
    actor: CredentialToolActor,
    name: CredentialToolName,
    input: unknown,
  ): Promise<unknown> {
    try {
      const parsed =
        credentialToolDefinitions[name].inputSchema.safeParse(input);
      if (!parsed.success)
        throw new CredentialError("credential_tool_input_invalid", 400);
      const context = await this.context(actor, parsed.data.runId);
      if (name === "prepare_credential_request" && "serviceId" in parsed.data) {
        const service = this.options.broker.serviceInfo(
          parsed.data.serviceId,
          parsed.data.mode,
        );
        return {
          ...service,
          ...context,
          submission: {
            method: "POST",
            url: `${this.options.basePath}/api/credential-requests`,
            body: {
              workspaceId: context.workspaceId,
              runId: context.runId,
              serviceId: service.serviceId,
              mode: service.mode,
            },
          },
          instruction:
            "The signed-in owner submits directly to the secure HTTP form endpoint. Never put secrets in chat, tools or URLs. The worker receives only an opaque reference when ready.",
        };
      }
      if (!("credentialRef" in parsed.data))
        throw new CredentialError("credential_tool_input_invalid", 400);
      const expected = await this.options.broker.forRun(
        parsed.data.credentialRef,
        { userId: actor.userId, runId: context.runId, taskId: context.taskId },
      );
      if (
        expected.workspaceId !== context.workspaceId ||
        expected.executionSession !== context.executionSession
      )
        throw new CredentialError("credential_not_found", 404);
      if (name === "credential_status")
        return this.options.broker.get(
          { ownerId: actor.userId, authSessionId: expected.authSessionId },
          parsed.data.credentialRef,
        );
      if (name === "credential_use")
        return await this.options.broker.use(
          parsed.data.credentialRef,
          expected,
        );
      if (name === "credential_browser_action" && "action" in parsed.data)
        return await this.options.broker.continueBrowser(
          parsed.data.credentialRef,
          expected,
          browserTaskActionSchema.parse(parsed.data.action),
        );
      if (name === "credential_finish")
        return await this.options.broker.finishBrowser(
          parsed.data.credentialRef,
          expected,
        );
      throw new CredentialError("credential_tool_input_invalid", 400);
    } catch (error) {
      // Model-visible results never contain provider/HTTP/Playwright errors or submitted values.
      return {
        error:
          error instanceof CredentialError
            ? error.code
            : "credential_unavailable",
      };
    }
  }
}
