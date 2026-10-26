import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Pool } from "pg";
import {
  createFactoryStore,
  type FactoryTaskSummary,
} from "../lib/factory/store";

// Explicit disposable local target only. Never use application/Neon credentials.
const enabled = process.env.FACTORY_QUERY_LOCAL_HTTP === "1";
test(
  "real local HTTP: issue discovery survives lost task ids and enforces owner, absence and revocation boundaries",
  { skip: !enabled, timeout: 120000 },
  async () => {
    const origin = new URL(process.env.FACTORY_QUERY_HTTP_ORIGIN!);
    const target = new URL(process.env.FACTORY_QUERY_DATABASE_URL!);
    assert.ok(["127.0.0.1", "localhost"].includes(origin.hostname));
    assert.equal(origin.protocol, "http:");
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.pathname, "/mikka_e2e");
    if (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true") {
      assert.equal(target.toString(), process.env.E2E_DATABASE_URL);
      assert.equal(target.username, "e2e");
    } else assert.equal(target.username, "factory192");
    const pool = new Pool({ connectionString: target.toString(), max: 4 });
    const requests: {
      clientRequestId: string;
      method: string;
      path: string;
      status: number;
      at: string;
    }[] = [];
    function client() {
      const cookies = new Map<string, string>();
      const ip = `198.18.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 254)}`;
      return async (
        path: string,
        method = "GET",
        body?: unknown,
        extra: Record<string, string> = {},
      ) => {
        const clientRequestId = randomUUID();
        const headers: Record<string, string> = {
          "x-forwarded-for": ip,
          "x-request-id": clientRequestId,
          ...extra,
        };
        if (cookies.size)
          headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          headers.origin = origin.origin;
        }
        const options: RequestInit = { method, headers };
        if (body !== undefined) options.body = JSON.stringify(body);
        const response = await fetch(new URL(`/mikka${path}`, origin), options);
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(";", 1)[0],
            split = pair.indexOf("=");
          cookies.set(pair.slice(0, split), pair.slice(split + 1));
        }
        requests.push({
          clientRequestId,
          method,
          path,
          status: response.status,
          at: new Date().toISOString(),
        });
        const text = await response.text();
        return {
          status: response.status,
          body: text ? JSON.parse(text) : null,
          headers: response.headers,
        };
      };
    }
    const owner = client(),
      other = client(),
      anonymous = client();
    const credentials = {
      email: `factory-query-${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString("base64url"),
      name: "Isolated HTTP fixture",
    };
    try {
      const a = await owner("/api/auth/sign-up/email", "POST", credentials);
      assert.equal(a.status, 200, "owner fixture signup must succeed");
      const b = await other("/api/auth/sign-up/email", "POST", {
        ...credentials,
        email: `other-${randomUUID()}@example.invalid`,
      });
      assert.equal(b.status, 200, "other fixture signup must succeed");
      const ownerId = a.body.user.id as string,
        otherId = b.body.user.id as string;
      const session = await owner("/api/auth/get-session");
      const sessionId = session.body.session.id as string;
      const issueId = randomUUID(),
        emptyIssueId = randomUUID(),
        foreignIssueId = randomUUID();
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Query fixture','{}','todo','normal'),($3,$2,'Empty fixture','{}','todo','normal'),($4,$5,'Foreign fixture','{}','todo','normal')`,
        [issueId, ownerId, emptyIssueId, foreignIssueId, otherId],
      );
      const store = createFactoryStore(
        pool,
        async (user, issue, tx) =>
          (
            await tx.query(
              'SELECT id FROM issues WHERE id=$1 AND "userId"=$2',
              [issue, user],
            )
          ).rowCount === 1,
      );
      async function task(userId: string, issue: string, ambiguous = false) {
        const sourceEventId = randomUUID();
        await pool.query(
          'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,\'user_message\',$3,\'{"text":"isolated query fixture"}\')',
          [sourceEventId, userId, `query:${sourceEventId}`],
        );
        return store.route(userId, {
          issueId: issue,
          eventId: sourceEventId,
          sourceEventId,
          rationale: "Authenticated fixture request",
          missingInformation: ambiguous ? ["Which target?"] : [],
        });
      }
      const first = await task(ownerId, issueId),
        second = await task(ownerId, issueId, true);
      const foreign = await task(otherId, foreignIssueId);
      for (let n = 0; n < 12; n++) {
        const id = randomUUID();
        await pool.query(
          'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,\'user_message\',$3,\'{"text":"later unrelated fixture request"}\')',
          [id, ownerId, `query-later:${id}`],
        );
      }
      const path = `/api/factory/tasks?issueId=${issueId}`;
      assert.equal((await anonymous(path)).status, 401);
      assert.equal(
        (
          await anonymous(path, "GET", undefined, {
            authorization: "Bearer fixture-worker-token",
          })
        ).status,
        401,
      );
      assert.equal((await other(path)).status, 404);
      assert.equal(
        (await owner(`/api/factory/tasks?issueId=${foreignIssueId}`)).status,
        404,
      );
      assert.equal(
        (await owner(`/api/factory/tasks?issueId=${randomUUID()}`)).status,
        404,
      );
      assert.equal(
        (await owner("/api/factory/tasks?issueId=invalid")).status,
        422,
      );
      assert.equal((await owner("/api/factory/tasks")).status, 422);
      const empty = await owner(`/api/factory/tasks?issueId=${emptyIssueId}`);
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.tasks, []);
      // A fresh authenticated client knows only the issue, not a prior task id or summary.
      const fresh = client();
      assert.equal(
        (
          await fresh("/api/auth/sign-in/email", "POST", {
            email: credentials.email,
            password: credentials.password,
          })
        ).status,
        200,
      );
      const countBefore = (
        await pool.query("SELECT count(*) FROM factory_events")
      ).rows[0].count;
      const discovered = await fresh(path);
      assert.equal(discovered.status, 200);
      assert.match(discovered.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(discovered.body.contractVersion, 1);
      const rows = discovered.body.tasks as FactoryTaskSummary[];
      assert.equal(rows.length, 2);
      assert.deepEqual(
        new Set(rows.map((r) => r.id)),
        new Set([first.task.id, second.task.id]),
      );
      assert.ok(
        rows.every((r) => r.issueId === issueId && r.id !== foreign.task.id),
      );
      assert.deepEqual(
        new Set(rows.map((r) => r.stage)),
        new Set(["execute", "clarify"]),
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM factory_events")).rows[0].count,
        countBefore,
        "discovery must not write stage events",
      );
      const waiting = rows.find((r) => r.id === second.task.id)!;
      const binding = (r: FactoryTaskSummary) => ({
        taskId: r.id,
        issueId: r.issueId,
        attemptId: r.attemptId,
        revision: r.revision,
        candidateId: r.candidateId,
      });
      assert.equal(
        (await fresh(`/api/factory/tasks/${waiting.id}`)).status,
        200,
      );
      assert.equal(
        (
          await fresh(`/api/factory/tasks/${waiting.id}`, "POST", {
            binding: binding(waiting),
            eventId: randomUUID(),
            action: "revoke",
            reason: "Owner withdraws fixture permission",
          })
        ).status,
        200,
      );
      const after = await fresh(path);
      assert.equal(after.status, 200);
      const revoked = (after.body.tasks as FactoryTaskSummary[]).find(
        (r) => r.id === waiting.id,
      )!;
      assert.equal(revoked.status, "revoked");
      assert.equal(revoked.reason, "Owner withdraws fixture permission");
      const rejected = await fresh(`/api/factory/tasks/${revoked.id}`, "POST", {
        binding: binding(revoked),
        eventId: randomUUID(),
        action: "retry",
        reason: "Forbidden reopening",
      });
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error, "factoryStopped");
      assert.equal(
        (await other(`/api/factory/tasks/${revoked.id}`)).status,
        404,
      );
      await pool.query("UPDATE issues SET content=$2 WHERE id=$1", [
        issueId,
        JSON.stringify({
          attrs: { mikka: { deletedAt: new Date().toISOString() } },
        }),
      ]);
      assert.equal((await fresh(path)).status, 404);
      assert.equal(
        (await fresh(`/api/factory/tasks/${first.task.id}`)).status,
        404,
      );
      assert.equal((await owner("/api/auth/sign-out", "POST", {})).status, 200);
      assert.equal(
        (await owner(`/api/factory/tasks?issueId=${emptyIssueId}`)).status,
        401,
      );
      const evidence = {
        environment:
          "Isolated local Node24 Next HTTP + disposable PG17; seeded task data",
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        origin: origin.origin,
        issueId,
        emptyIssueId,
        foreignIssueId,
        taskIds: rows.map((r) => r.id),
        attemptIds: rows.map((r) => r.attemptId),
        sessionId,
        requests,
        checks: [
          "fresh-client-issue-only-discovery-after-12-later-messages",
          "two-tasks-same-issue",
          "foreign-owner404",
          "nonexistent404",
          "empty200",
          "malformed422",
          "unauthenticated401",
          "bearer-not-session401",
          "query-no-event-writes",
          "revoked-visible-to-owner",
          "revoked-retry409",
          "deleted-issue404",
          "signed-out401",
        ],
        limitation:
          "No real Preview OAuth, model compaction or authorized Harness execution; those remain pending",
      };
      if (process.env.FACTORY_QUERY_EVIDENCE_DIR) {
        await mkdir(process.env.FACTORY_QUERY_EVIDENCE_DIR, {
          recursive: true,
        });
        await writeFile(
          `${process.env.FACTORY_QUERY_EVIDENCE_DIR}/query-http-evidence.json`,
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
      console.log(
        JSON.stringify({
          issueId,
          taskIds: evidence.taskIds,
          sessionId,
          requests: requests.length,
          checks: evidence.checks,
        }),
      );
    } finally {
      await pool.end();
    }
  },
);
