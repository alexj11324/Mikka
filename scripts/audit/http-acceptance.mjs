import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { oauthProvider } from "@better-auth/oauth-provider";
import { chromium } from "@playwright/test";

const origin = new URL(
  process.env.AUDIT_HTTP_ORIGIN ?? "http://127.0.0.1:3110",
);
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.protocol, "http:");
for (const key of ["AUDIT_APP_TEST_URL", "AUDIT_WORKSPACE_TEST_URL"]) {
  const url = new URL(process.env[key]);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.pathname.endsWith("_e2e"));
}
assert.notEqual(
  process.env.AUDIT_APP_TEST_URL,
  process.env.AUDIT_WORKSPACE_TEST_URL,
);
assert.ok(
  !process.env.RESEND_API_KEY &&
    !process.env.COMPOSIO_API_KEY &&
    !process.env.AI_GATEWAY_API_KEY,
);
const app = new Pool({ connectionString: process.env.AUDIT_APP_TEST_URL }),
  workspace = new Pool({
    connectionString: process.env.AUDIT_WORKSPACE_TEST_URL,
  });
const evidence = process.env.AUDIT_EVIDENCE_DIR ?? "/tmp/audit-210-http";
await mkdir(evidence, { recursive: true });
const requests = [];
const sha = process.env.AUDIT_EXACT_SHA;
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
function client() {
  const jar = new Map();
  return {
    jar,
    async call(path, method = "GET", body, extra = {}) {
      const requestId = randomUUID(),
        headers = { "x-request-id": requestId, ...extra };
      if (jar.size)
        headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const options = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers.origin = origin.origin;
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
        method,
        path,
        status: res.status,
        utc: new Date().toISOString(),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
}
let browser;
try {
  const authMigrations = await getMigrations({
    database: app,
    emailAndPassword: { enabled: true },
    plugins: [
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        disableJwtPlugin: true,
      }),
    ],
  });
  await authMigrations.runMigrations();
  const owner = client(),
    member = client(),
    outsider = client(),
    anonymous = client();
  const account = () => ({
    name: "Synthetic audit acceptance",
    email: `audit-${randomUUID()}@example.invalid`,
    password: randomBytes(32).toString("base64url"),
  });
  const ownerCredentials = account(),
    memberCredentials = account(),
    outsiderCredentials = account();
  const signup = await owner.call(
    "/api/auth/sign-up/email",
    "POST",
    ownerCredentials,
  );
  assert.equal(signup.status, 200);
  const ownerId = signup.body.user.id;
  const ms = await member.call(
    "/api/auth/sign-up/email",
    "POST",
    memberCredentials,
  );
  assert.equal(ms.status, 200);
  const memberId = ms.body.user.id;
  const os = await outsider.call(
    "/api/auth/sign-up/email",
    "POST",
    outsiderCredentials,
  );
  assert.equal(os.status, 200);
  const bad = await anonymous.call("/api/auth/sign-in/email", "POST", {
    email: ownerCredentials.email,
    password: randomUUID(),
  });
  assert.equal(bad.status, 401);
  const workspaceId = randomUUID(),
    otherWorkspaceId = randomUUID();
  await workspace.query(
    `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic audit one'),($3,$4,'Synthetic audit two')`,
    [workspaceId, ownerId, otherWorkspaceId, os.body.user.id],
  );
  await workspace.query(
    `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Synthetic',$3,'admin','active'),($1,$4,'Synthetic',$5,'member','active'),($6,$7,'Synthetic',$8,'admin','active')`,
    [
      workspaceId,
      ownerId,
      ownerCredentials.email,
      memberId,
      memberCredentials.email,
      otherWorkspaceId,
      os.body.user.id,
      outsiderCredentials.email,
    ],
  );
  const path = `/api/audit?workspaceId=${workspaceId}`;
  assert.equal((await anonymous.call(path)).status, 401);
  assert.equal((await member.call(path)).status, 403);
  assert.equal((await outsider.call(path)).status, 403);
  assert.equal(
    (
      await owner.call(path, "GET", undefined, {
        authorization: "Bearer mkw_synthetic",
      })
    ).status,
    401,
  );
  assert.equal(
    (await owner.call(`/api/audit?workspaceId=${otherWorkspaceId}`)).status,
    403,
  );
  assert.equal((await owner.call(path + "&source=workspace")).status, 200);
  assert.equal((await owner.call("/api/audit")).status, 200);
  assert.equal(
    (await owner.call(path, "POST", { operation: "verify" })).status,
    200,
  );
  assert.equal(
    (
      await owner.call(path + "&source=workspace", "POST", {
        operation: "verify",
      })
    ).status,
    200,
  );
  const id = randomUUID(),
    exportPath = `/api/audit/export?workspaceId=${workspaceId}`;
  const created = await owner.call(
    exportPath,
    "POST",
    {},
    { "idempotency-key": id },
  );
  assert.equal(created.status, 200);
  const repeated = await owner.call(
    exportPath,
    "POST",
    {},
    { "idempotency-key": id },
  );
  assert.equal(repeated.status, 200);
  assert.equal(
    created.body.snapshots.application.upper_seq,
    repeated.body.snapshots.application.upper_seq,
  );
  const files = [];
  for (const source of ["application", "workspace"]) {
    const snapshot = created.body.snapshots[source];
    let after = snapshot.lower_seq,
      count = 0,
      last = snapshot.start_hash,
      pages = 0;
    do {
      const endpoint = `${exportPath}&id=${id}&source=${source}&after=${after}&limit=1`;
      const headers = {
        cookie: [...owner.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      };
      const response = await fetch(new URL("/mikka" + endpoint, origin), {
        headers,
      });
      assert.equal(response.status, 200);
      const text = await response.text(),
        lines = text
          .trim()
          .split("\n")
          .map((v) => JSON.parse(v)),
        manifest = lines.shift();
      for (const row of lines) {
        assert.equal(row.prev_hash, last);
        assert.equal(
          row.hash,
          createHash("sha256")
            .update(`${last}\n${row.canonical}`)
            .digest("hex"),
        );
        last = row.hash;
        count++;
      }
      const raw = lines.map((r) => JSON.stringify(r)).join("\n");
      assert.equal(
        manifest.pageDigest,
        createHash("sha256").update(raw).digest("hex"),
      );
      const file = `${source}-page-${pages++}.jsonl`;
      await writeFile(`${evidence}/${file}`, text);
      files.push(file);
      requests.push({
        method: "GET",
        path: endpoint,
        status: response.status,
        utc: new Date().toISOString(),
      });
      if (!manifest.next) break;
      after = manifest.next;
    } while (count < Number(snapshot.count));
    assert.equal(count, Number(snapshot.count));
    assert.equal(last, snapshot.end_hash);
  }
  await workspace.query(
    'UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',
    [workspaceId, ownerId],
  );
  assert.equal((await owner.call(path)).status, 403);
  await workspace.query(
    'UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',
    [workspaceId, ownerId],
  );
  assert.equal(
    (
      await owner.call(path + "&source=workspace", "POST", {
        operation: "policy",
        retentionDays: 90,
        legalHold: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await owner.call(path + "&source=workspace", "POST", {
        operation: "prune",
      })
    ).body.error,
    "auditLegalHold",
  );
  assert.equal(
    (
      await owner.call(path + "&source=workspace", "POST", {
        operation: "policy",
        retentionDays: 90,
        legalHold: false,
      })
    ).status,
    200,
  );
  const authEvents = (
    await app.query("SELECT event FROM security_audit_events WHERE tenant=$1", [
      `personal:${ownerId}`,
    ])
  ).rows;
  assert.ok(authEvents.some((r) => r.event.action === "auth.login"));
  assert.ok(
    (
      await app.query(
        "SELECT 1 FROM security_audit_events WHERE tenant='system:auth' AND event->>'action'='auth.denied' LIMIT 1",
      )
    ).rowCount,
  );
  assert.ok(
    (
      await workspace.query(
        "SELECT 1 FROM security_audit_events WHERE tenant=$1 AND event->>'action'='membership.update'",
        [workspaceId],
      )
    ).rowCount,
  );
  const serialized = JSON.stringify(authEvents);
  assert.ok(
    !serialized.includes(ownerCredentials.password) &&
      !serialized.includes(ownerCredentials.email),
  );
  // Actual Chromium navigations to the running Mikka backend. Only sanitised API bodies enter video.
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: evidence, size: { width: 1280, height: 800 } },
  });
  await context.addCookies(
    [...owner.jar].map(([name, value]) => ({
      name,
      value,
      url: origin.origin,
    })),
  );
  const page = await context.newPage();
  await page.goto(new URL("/mikka" + path + "&source=workspace", origin).href);
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: `${evidence}/workspace-query.png`,
    fullPage: true,
  });
  await page.goto(new URL("/mikka/api/audit", origin).href);
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: `${evidence}/personal-query.png`,
    fullPage: true,
  });
  await context.clearCookies();
  await context.addCookies(
    [...member.jar].map(([name, value]) => ({
      name,
      value,
      url: origin.origin,
    })),
  );
  await page.goto(new URL("/mikka" + path, origin).href);
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: `${evidence}/member-denied.png`,
    fullPage: true,
  });
  const video = page.video();
  await context.close();
  await video.saveAs(`${evidence}/audit-http-raw.webm`);
  await browser.close();
  browser = undefined;
  await writeFile(
    `${evidence}/acceptance.json`,
    JSON.stringify(
      {
        sha,
        origin: origin.origin,
        utc: new Date().toISOString(),
        scope:
          "isolated cloud Linux production-built Next HTTP; synthetic accounts; no real provider/production acceptance",
        workspaceId,
        otherWorkspaceId,
        ownerId,
        memberId,
        exportId: id,
        files,
        requests,
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
      origin: origin.origin,
      requests: requests.length,
      workspaceId,
      otherWorkspaceId,
      evidence,
    }),
  );
} finally {
  await browser?.close();
  await Promise.all([app.end(), workspace.end()]);
}
