import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { chromium } from "@playwright/test";
const sha = process.env.AUDIT_EXACT_SHA,
  origin = new URL(process.env.AUDIT_HTTP_ORIGIN ?? "http://127.0.0.1:3110"),
  directory = process.env.AUDIT_EVIDENCE_DIR ?? "/tmp/audit-continuation-http";
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
assert.equal(origin.hostname, "127.0.0.1");
const targets = ["AUDIT_APP_TEST_URL", "AUDIT_WORKSPACE_TEST_URL"].map(
  (key) => {
    const url = new URL(process.env[key]);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(url.pathname.endsWith("_e2e"));
    return url.href;
  },
);
assert.notEqual(...targets);

// Evidence-only wrapper: no product changes. Records safe request metadata live.
const recorder = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const recording = await recorder.newContext({viewport:{width:1280,height:800},recordVideo:{dir:directory,size:{width:1280,height:800}}});
const screen = await recording.newPage();
await screen.setContent('<html><body style="background:#101720;color:#e4edf5;font:19px monospace;padding:24px"><h2>Audit #210 | Continuation acceptance</h2><p>Live acceptance harness: real Next HTTP + isolated PostgreSQL</p><p>Synthetic fixtures only. No provider / production execution.</p><p id="sha"></p><pre id="requests" style="white-space:pre-wrap;font-size:17px"></pre><p id="result"></p></body></html>');
await screen.locator('#sha').evaluate((el,v)=>el.textContent='Source '+v,sha);
await screen.waitForTimeout(2000);

const app = new Pool({ connectionString: targets[0] }),
  workspace = new Pool({ connectionString: targets[1] }),
  requests = [];
function browser() {
  const jar = new Map();
  return async (path, method = "GET", body, extra = {}) => {
    const requestId = randomUUID(),
      headers = { origin: origin.origin, "x-request-id": requestId, ...extra };
    if (jar.size)
      headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const options = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const res = await fetch(new URL("/mikka" + path, origin), options);
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    requests.push({
      requestId,
      path,
      method,
      status: res.status,
      utc: new Date().toISOString(),
    });
    await screen.locator('#requests').evaluate((el,rows)=>el.textContent=rows.map((v,i)=>`${String(i+1).padStart(2,'0')} ${v.method.padEnd(5)} ${v.path.split('?')[0]}  -> ${v.status}`).join('\n'),requests);
    await screen.waitForTimeout(1000);
    const text = await res.text();
    return {
      status: res.status,
      text,
      body:
        res.headers.get("content-type")?.includes("application/json") && text
          ? JSON.parse(text)
          : null,
    };
  };
}
try {
  const owner = browser(),
    foreign = browser(),
    account = () => ({
      name: "Synthetic continuation",
      email: `continuation-${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString("base64url"),
    });
  const a = await owner("/api/auth/sign-up/email", "POST", account()),
    b = await foreign("/api/auth/sign-up/email", "POST", account());
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const ownerId = a.body.user.id,
    otherId = b.body.user.id,
    tenant = randomUUID(),
    otherTenant = randomUUID(),
    device = randomUUID(),
    agent = randomUUID(),
    repo = randomUUID(),
    issue = randomUUID(),
    parent = randomUUID(),
    box = randomUUID(),
    tokenId = randomUUID(),
    token = "orv_" + randomBytes(32).toString("base64url");
  await workspace.query(
    `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic continuation'),($3,$4,'Synthetic foreign')`,
    [tenant, ownerId, otherTenant, otherId],
  );
  for (const [w, u] of [
    [tenant, ownerId],
    [otherTenant, otherId],
  ])
    await workspace.query(
      `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Synthetic','synthetic@example.invalid','admin','active')`,
      [w, u],
    );
  await app.query(
    `INSERT INTO devices(id,"ownerId",name,"lastSeenAt") VALUES($1,$2,'Synthetic continuation',now())`,
    [device, ownerId],
  );
  await app.query(
    `INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,'codex',$4)`,
    [agent, ownerId, agent, device],
  );
  await app.query(
    `INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,'/synthetic/continuation')`,
    [repo, device, ownerId],
  );
  await app.query(
    `INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,'Synthetic continuation','{}','todo','normal','workspace')`,
    [issue, ownerId],
  );
  await app.query(
    `INSERT INTO session_mailboxes(id,"userId","workspaceId",kind,"sessionKey",harness) VALUES($1::uuid,$2,'00000000-0000-4000-8000-000000000001','run',$1::text,'codex')`,
    [box, ownerId],
  );
  const seed = await app.connect();
  try {
    await seed.query("BEGIN");
    await seed.query("SELECT set_config('mikka.audit_workspace',$1,true)", [
      tenant,
    ]);
    await seed.query(
      `INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","mailboxId",status,"stopReason","sessionId","worktreePath") VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded','submitted','synthetic-session','/synthetic/worktree')`,
      [parent, ownerId, issue, agent, device, repo, box],
    );
    await seed.query("COMMIT");
  } finally {
    seed.release();
  }
  await app.query('UPDATE session_mailboxes SET "latestRunId"=$2 WHERE id=$1', [
    box,
    parent,
  ]);
  await app.query(
    `INSERT INTO run_messages(id,"userId","mailboxId",text,origin) VALUES($1,$2,$3,'Synthetic follow-up','peer')`,
    [randomUUID(), ownerId, box],
  );
  assert.equal(
    (
      await foreign(`/api/mailboxes/${box}`, "PATCH", {
        wakeBudget: 1,
        disabled: false,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await owner(`/api/mailboxes/${box}`, "POST", {
        key: randomUUID(),
        text: "Synthetic forbidden parent field",
        resume: true,
        continuesRunId: randomUUID(),
      })
    ).status,
    400,
  );
  const scheduled = await owner(`/api/mailboxes/${box}`, "PATCH", {
    wakeBudget: 1,
    disabled: false,
  });
  assert.equal(scheduled.status, 200);
  const child = scheduled.body.continuationRunId;
  assert.ok(child);
  const row = (
    await app.query(
      'SELECT "continuesRunId","retryOf" FROM agent_runs WHERE id=$1',
      [child],
    )
  ).rows[0];
  assert.equal(row.continuesRunId, parent);
  assert.equal(row.retryOf, null);
  await app.query(
    `INSERT INTO device_tokens(id,"userId",name,"tokenHash") VALUES($1,$2,'Synthetic continuation',$3)`,
    [tokenId, ownerId, createHash("sha256").update(token).digest("hex")],
  );
  const worker = async (path, body) => {
    const requestId = randomUUID(),
      res = await fetch(new URL("/mikka" + path, origin), {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify(body),
      });
    requests.push({
      requestId,
      path,
      method: "POST",
      status: res.status,
      utc: new Date().toISOString(),
    });
    return res;
  };
  assert.equal(
    (await worker(`/v1/devices/${device}/runs/${child}/claim`, {})).status,
    200,
  );
  assert.equal(
    (await worker(`/v1/runs/${child}/complete`, { stopReason: "turn_ended" }))
      .status,
    204,
  );
  const events = (
    await app.query(
      "SELECT tenant,seq,event,hash FROM security_audit_events WHERE event->>'runId'=$1 ORDER BY seq",
      [child],
    )
  ).rows;
  assert.ok(events.length >= 4);
  assert.ok(events.every((e) => e.tenant === tenant));
  assert.ok(
    events.some(
      (e) => e.event.action === "worker.claim" && e.event.actorId === tokenId,
    ),
  );
  assert.ok(events.some((e) => e.event.reason === "stopped"));
  const visible = await owner(`/api/audit?workspaceId=${tenant}`);
  assert.equal(visible.status, 200);
  assert.ok(visible.body.events.some((e) => e.event.runId === child));
  assert.equal((await foreign(`/api/audit?workspaceId=${tenant}`)).status, 403);
  const exportId = randomUUID();
  const created = await owner(
    `/api/audit/export?workspaceId=${tenant}`,
    "POST",
    {},
    { "idempotency-key": exportId },
  );
  assert.equal(created.status, 200);
  const snapshot = created.body.snapshots.application;
  const exported = await owner(
    `/api/audit/export?workspaceId=${tenant}&id=${exportId}&source=application&after=${snapshot.lower_seq}&limit=200`,
  );
  assert.equal(exported.status, 200);
  const lines = exported.text
      .trim()
      .split("\n")
      .map((v) => JSON.parse(v)),
    manifest = lines.shift();
  assert.equal(manifest.next, null);
  assert.equal(lines.length, Number(snapshot.count));
  assert.ok(
    lines.some((e) => JSON.parse(e.canonical).data.runId === child),
    "workspace JSONL must include the ordinary continuation",
  );
  await writeFile(directory + "/continuation-export.jsonl", exported.text);
  await writeFile(
    directory + "/continuation-http.json",
    JSON.stringify(
      {
        sha,
        origin: origin.origin,
        utc: new Date().toISOString(),
        layer:
          "actual Next mailbox policy -> ordinary continuation -> worker claim/complete -> authorized audit query; synthetic only",
        ownerId,
        tenant,
        otherTenant,
        parentRunId: parent,
        childRunId: child,
        mailboxId: box,
        exportId,
        requests,
        events,
        status: "passed",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      sha,
      parent,
      child,
      requests: requests.length,
      events: events.length,
    }),
  );
  await screen.locator('#result').evaluate((el,v)=>el.textContent='PASS: workspace continuation present in query and JSONL; foreign access denied. Child '+v,child);
  await screen.screenshot({path:directory+'/continuation-live-summary.png'});
  await screen.waitForTimeout(5000);
} finally {
  await recording.close();
  await (await screen.video()).saveAs(directory+'/continuation-live-raw.webm');
  await recorder.close();
  await Promise.all([app.end(), workspace.end()]);
}
