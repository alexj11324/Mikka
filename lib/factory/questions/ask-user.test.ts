import assert from "node:assert/strict";
import test from "node:test";
import { handleFactoryQuestionList, toAskUserQuestion } from "./ask-user";

const base = { id: "q1", taskId: "t1", originRunId: "r1", status: "open", question: "Pick one", options: ["A"], reference: { questionId: "q1" } };

test("headers are short chips for every question kind; options carry an empty description and value = label", () => {
  for (const [kind, header] of [["context", "Context"], ["decision", "Decision"], ["permission", "Permission"], ["external", "External"], ["somethingverylong", "somethingver"]]) {
    const q = toAskUserQuestion({ ...base, kind });
    assert.equal(q.header, header);
    assert.ok(q.header.length <= 12);
    assert.equal(q.type, kind);
  }
  assert.deepEqual(toAskUserQuestion({ ...base, kind: "decision", options: null }).options, []);
  assert.deepEqual(toAskUserQuestion({ ...base, kind: "decision" }).options, [{ label: "A", description: "", value: "A" }]);
  assert.equal(toAskUserQuestion({ ...base, kind: "decision" }).multiSelect, false);
});

test("only pending statuses are listed and the run filter matches origin or continuation", async () => {
  const rows = [
    { ...base, id: "a", kind: "decision", status: "resolved" },
    { ...base, id: "b", kind: "decision", status: "blocked", continuationRunId: "r2" },
    { ...base, id: "c", kind: "decision", status: "waiting_user" },
  ];
  const service = { pending: async () => rows, list: async () => rows } as never;
  const get = async (q: string) => ((await handleFactoryQuestionList(service, { actor: { userId: "u" }, authorization: null, method: "GET", url: `https://x.test/api/factory/questions${q}` })).body as { questions: { questionId: string }[] }).questions.map((x) => x.questionId);
  assert.deepEqual(await get(""), ["b", "c"]);
  assert.deepEqual(await get("?runId=00000000-0000-4000-8000-000000000000"), []);
  assert.equal((await handleFactoryQuestionList(service, { actor: { userId: "u" }, authorization: "Bearer x", method: "GET", url: "https://x.test/" })).status, 401);
  assert.equal((await handleFactoryQuestionList(service, { actor: { userId: "u" }, authorization: null, method: "POST", url: "https://x.test/" })).status, 405);
});
