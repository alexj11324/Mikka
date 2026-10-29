import "server-only";
import type { PoolClient } from "pg";
import {
  encodedIssueDocument,
  loadIssueDocument,
  upsertLinearComment,
} from "../linear-sync/document";
import type { MonitorNotice } from "./monitor";

/** Existing issue comments + existing document trigger/outbox, never a second sync worker. */
export async function appendMonitorEvidence(
  tx: PoolClient,
  notice: MonitorNotice,
) {
  const {
    rows: [issue],
  } = await tx.query("SELECT * FROM issues WHERE id=$1 FOR UPDATE", [
    notice.issueId,
  ]);
  const {
    rows: [document],
  } = await tx.query(
    'SELECT state FROM issue_documents WHERE "issueId"=$1 FOR UPDATE',
    [notice.issueId],
  );
  const doc = loadIssueDocument(document?.state ?? null, issue.content);
  try {
    upsertLinearComment(doc, {
      threadId: notice.incidentId ?? notice.taskId,
      messageId: notice.observationId,
      author: "Factory monitor",
      // No authorUserId: never impersonate the person who owns the issue.
      body: [
        `Factory monitor: ${notice.outcome}. Occurrences: ${notice.occurrences}.`,
        `SHA: ${notice.sha}; candidate environment: ${notice.environment}.`,
        ...(notice.target
          ? [
              `Observed target: ${notice.kind}:${notice.target}; target environment: ${notice.targetEnvironment}; publication: ${notice.publicationId}; operation: ${notice.operationId}; reference: ${notice.checkedReference}.`,
            ]
          : []),
        `Task: ${notice.taskId}; candidate: ${notice.candidateId}.`,
        `Event: ${notice.sourceEventId}; run: ${notice.runId}; session: ${notice.sessionId}.`,
        `Evidence: run-report:${notice.runId}; observation: ${notice.observationId}.`,
        ...(notice.fingerprint ? [`Fingerprint: ${notice.fingerprint}.`] : []),
        ...(notice.transitionBlocked
          ? ["Stage transition blocked; frozen contract coordination required."]
          : []),
      ].join("\n"),
      at: new Date().toISOString(),
    });
    await tx.query(
      `INSERT INTO issue_documents ("issueId","userId",state,"updatedAt") VALUES ($1,$2,$3,now())
       ON CONFLICT ("issueId") DO UPDATE SET state=excluded.state,"updatedAt"=now()`,
      [issue.id, issue.userId, encodedIssueDocument(doc)],
    );
  } finally {
    doc.destroy();
  }
}
