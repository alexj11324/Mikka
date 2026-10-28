import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { isolatedPostgresURL } from "../../tests/helpers/isolated-postgres.mjs";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { improvementTestDatabase } from "./test-database";
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from "./builtin-skill";
import { withdrawSkillApproval } from "./activation";
import type { FactoryTask } from "../factory/store";

const databaseURL = improvementTestDatabase(process.env);
test(
  "PG activation and approval withdrawal remain atomic, immutable and replay-safe",
  { skip: !databaseURL, timeout: 120000 },
  async (t) => {
    const target = new URL(await isolatedPostgresURL(databaseURL!)),
      schema = `skill_activation_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: target.toString(), max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    target.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: target.toString(), max: 3 });
    t.after(async () => {
      await pool.end();
      await admin.end();
    });
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const name of orderMigrations(
      (await readdir(dir)).filter((n) => n.endsWith(".sql")),
    ))
      await pool.query(await readFile(new URL(name, dir), "utf8"));
    // Explicit reapplication covers migrate-ledger interruption after committed SQL.
    await pool.query(
      await readFile(
        new URL("20261028231601_skill_lifecycle_operations.sql", dir),
        "utf8",
      ),
    );
    const userId = `synthetic-${randomUUID()}`,
      issueId = randomUUID(),
      taskId = randomUUID(),
      candidateId = randomUUID(),
      attemptId = randomUUID(),
      runId = randomUUID(),
      eventId = randomUUID(),
      proposalId = randomUUID(),
      repoId = randomUUID(),
      approvalId = randomUUID(),
      publicationId = randomUUID();
    await pool.query(
      `INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Synthetic activation transaction fixture','{}','todo','normal')`,
      [issueId, userId],
    );
    await pool.query(
      `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey","issueId",payload) VALUES($1,$2,'user_message',$3,$4,'{}')`,
      [eventId, userId, eventId, issueId],
    );
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        `INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES($1,$2,$3,$4,'{}','publish','pending',$5,'fixture')`,
        [taskId, userId, issueId, eventId, attemptId],
      );
      await tx.query(
        `INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId") VALUES($1,$2,$3,'fixture/Mikka','device:fixture','Skill',$4)`,
        [candidateId, taskId, "a".repeat(40), runId],
      );
      await tx.query(
        `INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES($1,$2,'publish',1,1,'pending',$3,'fixture')`,
        [attemptId, taskId, candidateId],
      );
      await tx.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [
        taskId,
        candidateId,
      ]);
      await tx.query(
        `INSERT INTO factory_approvals(id,"taskId","candidateId","attemptId","userId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES($1,$2,$3,$4,$5,'synthetic-session',$6,'{}','{}','activate_skill','mikka-builtin:run-report','fixture','{}',1,$4,1,clock_timestamp()+interval '1 hour')`,
        [approvalId, taskId, candidateId, attemptId, userId, randomUUID()],
      );
      await tx.query(
        `INSERT INTO factory_publications(id,"approvalId","taskId","candidateId",action,target,"eventId",request,status) VALUES($1,$2,$3,$4,'activate_skill','mikka-builtin:run-report',$5,'{}','succeeded')`,
        [publicationId, approvalId, taskId, candidateId, randomUUID()],
      );
      await tx.query(
        `INSERT INTO improvement_scorers(digest,id,version,definition) VALUES('fixture','fixture',1,'{}')`,
      );
      await tx.query(
        `INSERT INTO improvement_proposals(id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status) VALUES($1,$2,'fixture',$3,$4,'fixture','{}','{}','awaiting_model_candidate')`,
        [proposalId, userId, proposalId, issueId],
      );
      await tx.query(
        `INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3),($4,$5,$3)`,
        [
          BASELINE_ARTIFACT.versionId,
          JSON.stringify(BASELINE_ARTIFACT),
          BASELINE_MARKDOWN,
          candidateId,
          JSON.stringify({ ...BASELINE_ARTIFACT, versionId: candidateId }),
        ],
      );
      await tx.query(
        `INSERT INTO improvement_skill_candidates("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId") VALUES($1,$2,$3,$4,$5,$6,$7,$1,'fixture/Mikka',$8,'lib/self-improvement/skills/run-report/SKILL.md',$9)`,
        [
          candidateId,
          userId,
          issueId,
          randomUUID(),
          repoId,
          proposalId,
          taskId,
          "a".repeat(40),
          BASELINE_ARTIFACT.versionId,
        ],
      );
      await tx.query(
        `INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId") VALUES($1,$2,$3,$4,$5,'activate',$6,$7)`,
        [
          randomUUID(),
          userId,
          issueId,
          repoId,
          candidateId,
          publicationId,
          approvalId,
        ],
      );
      await tx.query("COMMIT");
      const task = { id: taskId, userId, issueId } as FactoryTask;
      await tx.query("BEGIN");
      await tx.query(
        'UPDATE factory_approvals SET "revokedAt"=clock_timestamp() WHERE id=$1',
        [approvalId],
      );
      await withdrawSkillApproval(tx, task, approvalId);
      await tx.query("ROLLBACK");
      assert.equal(
        (
          await pool.query(
            'SELECT "revokedAt" FROM factory_approvals WHERE id=$1',
            [approvalId],
          )
        ).rows[0].revokedAt,
        null,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM improvement_skill_lifecycle WHERE "publicationId"=$1',
            [publicationId],
          )
        ).rowCount,
        1,
      );
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE", [
        taskId,
      ]);
      await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [issueId]);
      await tx.query(
        'UPDATE factory_approvals SET "revokedAt"=clock_timestamp() WHERE id=$1',
        [approvalId],
      );
      await withdrawSkillApproval(tx, task, approvalId);
      await withdrawSkillApproval(tx, task, approvalId);
      await tx.query("COMMIT");
      assert.ok(
        (
          await pool.query(
            'SELECT "revokedAt" FROM factory_approvals WHERE id=$1',
            [approvalId],
          )
        ).rows[0].revokedAt,
      );
      const events = (
        await pool.query(
          'SELECT * FROM improvement_skill_lifecycle WHERE "publicationId"=$1 ORDER BY "createdAt"',
          [publicationId],
        )
      ).rows;
      assert.deepEqual(
        events.map((row) => row.operation),
        ["activate", "withdraw"],
      );
      await assert.rejects(
        pool.query(
          `UPDATE improvement_skill_lifecycle SET operation='activate' WHERE id=$1`,
          [events[1].id],
        ),
        /immutable/,
      );
      await assert.rejects(
        pool.query("DELETE FROM improvement_skill_lifecycle WHERE id=$1", [
          events[0].id,
        ]),
        /immutable/,
      );
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
    }
  },
);
