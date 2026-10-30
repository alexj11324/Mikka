import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { factoryEvidenceMedia, type EvidenceMediaDeps } from "./evidence-media";
import { FactoryError } from "./contract";

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const sha = createHash("sha256").update(bytes).digest("hex");
const actor = { userId: "owner", sessionId: "s1" };
const file = { id: "c1", kind: "image" as const, contentType: "image/png" as const, title: "Home", size: bytes.length, durationMs: null, source: "local" as const, createdAt: new Date(0).toISOString(), bytes: new Uint8Array(bytes) };
const deps = (patch: Partial<EvidenceMediaDeps> = {}): EvidenceMediaDeps => ({
  capture: async () => ({ ownerId: "owner", sha256: sha }),
  read: async (userId) => (userId === "owner" ? file : null),
  ...patch,
});
const get = (headers: Record<string, string> = {}) => new Request("https://mikka.example/api/factory/tasks/t/evidence/c1", { headers });
const input = { actor, taskId: "t", captureId: "c1" };

test("serves the bound capture through the captures serve path, private and sandboxed", async () => {
  const response = await factoryEvidenceMedia(get(), input, deps());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("byte ranges still work so a recording can seek", async () => {
  const response = await factoryEvidenceMedia(get({ range: "bytes=2-3" }), input, deps());
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 2-3/${bytes.length}`);
});

test("a file whose bytes no longer hash to the bound sha256 is refused", async () => {
  const response = await factoryEvidenceMedia(get(), input, deps({ capture: async () => ({ ownerId: "owner", sha256: "0".repeat(64) }) }));
  assert.equal(response.status, 409);
});

test("no browser session, a delegated token, or another owner never reaches the file", async () => {
  let reads = 0;
  const counting = deps({ read: async () => { reads++; return file; } });
  assert.equal((await factoryEvidenceMedia(get(), { ...input, actor: null }, counting)).status, 401);
  assert.equal((await factoryEvidenceMedia(get({ authorization: "Bearer x" }), input, counting)).status, 401);
  assert.equal((await factoryEvidenceMedia(get(), input, deps({ ...counting, capture: async () => ({ ownerId: "someone-else", sha256: sha }) }))).status, 404);
  assert.equal(reads, 0);
});

test("acceptance errors map to the same statuses as the approval route", async () => {
  const failing = (code: string) => deps({ capture: async () => { throw new FactoryError(code as never); } });
  assert.equal((await factoryEvidenceMedia(get(), input, failing("factoryNotFound"))).status, 404);
  assert.equal((await factoryEvidenceMedia(get(), input, failing("factoryArtifactMissing"))).status, 404);
  assert.equal((await factoryEvidenceMedia(get(), input, failing("factoryHumanRequired"))).status, 401);
  assert.equal((await factoryEvidenceMedia(get(), input, failing("factoryEvidenceMismatch"))).status, 409);
  assert.equal((await factoryEvidenceMedia(get(), input, deps({ read: async () => null }))).status, 404);
  await assert.rejects(() => factoryEvidenceMedia(get(), input, deps({ capture: async () => { throw new Error("db down"); } })), /db down/);
});
