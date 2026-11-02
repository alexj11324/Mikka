import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  QUESTION_KINDS,
  contextQuestionAnswerSchema,
  humanQuestionAnswerSchema,
  legacyQuestionId,
  orchestratorMayAnswer,
  questionFingerprint,
  questionHandoffSchema,
  questionReferenceSchema,
} from "./contract";
import * as pure from "./schema";
import { factoryDispatchSchema } from "../dispatch-schema";
import { factoryDispatchSchema as serverDispatchSchema } from "../dispatch";

const reference = () => ({
  questionId: randomUUID(),
  questionRevision: 2,
  originRunId: randomUUID(),
  originSessionId: "synthetic-session",
  binding: {
    taskId: randomUUID(),
    issueId: randomUUID(),
    attemptId: randomUUID(),
    revision: 3,
    candidateId: null,
  },
});
test("question identity requires original run/session plus complete current Factory fence", () => {
  const value = reference();
  assert.ok(questionReferenceSchema.safeParse(value).success);
  for (const key of [
    "questionId",
    "questionRevision",
    "originRunId",
    "originSessionId",
    "binding",
  ]) {
    const copy: Record<string, unknown> = { ...value };
    delete copy[key];
    assert.equal(questionReferenceSchema.safeParse(copy).success, false);
  }
  assert.equal(
    questionReferenceSchema.safeParse({ ...value, userId: "forged-owner" })
      .success,
    false,
  );
  assert.equal(
    questionReferenceSchema.safeParse({ ...value, originSessionId: "" })
      .success,
    false,
  );
});
test("hand-in retains a supplied questionId; legacy ID is stable for one run", () => {
  const runId = randomUUID(),
    questionId = randomUUID();
  assert.equal(legacyQuestionId(runId), legacyQuestionId(runId));
  assert.notEqual(legacyQuestionId(runId), legacyQuestionId(randomUUID()));
  assert.ok(
    questionReferenceSchema.shape.questionId.safeParse(legacyQuestionId(runId))
      .success,
  );
  const parsed = questionHandoffSchema.parse({
    questionId,
    question: "Which product behavior?",
  });
  assert.equal(parsed.questionId, questionId);
  assert.equal(parsed.kind, "decision");
  assert.deepEqual(parsed.options, []);
});
test("Orchestrator answer schema requires fact provenance and cannot assert a human source", () => {
  const value = {
    reference: reference(),
    answerId: randomUUID(),
    facts: [
      {
        kind: "request",
        sourceEventId: randomUUID(),
        quote: "Keep the existing public API",
      },
    ],
  };
  assert.ok(contextQuestionAnswerSchema.safeParse(value).success);
  assert.equal(
    contextQuestionAnswerSchema.safeParse({ ...value, source: "human" })
      .success,
    false,
  );
  assert.equal(
    contextQuestionAnswerSchema.safeParse({
      ...value,
      text: "I approve production",
    }).success,
    false,
  );
  assert.equal(
    contextQuestionAnswerSchema.safeParse({ ...value, facts: [] }).success,
    false,
  );
  assert.equal(
    contextQuestionAnswerSchema.safeParse({
      ...value,
      facts: [{ kind: "permission", quote: "granted" }],
    }).success,
    false,
  );
  for (const kind of QUESTION_KINDS)
    assert.equal(orchestratorMayAnswer(kind), kind === "context");
});
test("human answer cannot inject source, scope or approval grants", () => {
  const value = {
    reference: reference(),
    answerId: randomUUID(),
    text: "Preserve the original behavior",
  };
  assert.ok(humanQuestionAnswerSchema.safeParse(value).success);
  for (const extra of [
    { source: "human" },
    { approved: true },
    { permission: "admin" },
    { facts: [] },
  ])
    assert.equal(
      humanQuestionAnswerSchema.safeParse({ ...value, ...extra }).success,
      false,
    );
});
test("answer fingerprints ignore object key order but bind actor, source, answer and original question", () => {
  const value = {
    actorId: "owner",
    source: "human",
    answer: humanQuestionAnswerSchema.parse({
      reference: reference(),
      answerId: randomUUID(),
      text: "Use v2",
    }),
  };
  const same = {
    answer: value.answer,
    source: value.source,
    actorId: value.actorId,
  };
  assert.equal(questionFingerprint(value), questionFingerprint(same));
  for (const changed of [
    { ...value, actorId: "other" },
    { ...value, source: "orchestrator" },
    { ...value, answer: { ...value.answer, answerId: randomUUID() } },
    { ...value, answer: { ...value.answer, text: "Use v3" } },
    { ...value, answer: { ...value.answer, reference: reference() } },
  ])
    assert.notEqual(questionFingerprint(value), questionFingerprint(changed));
});
test("Workflow-safe schemas lowercase UUIDs and are the server contract's schemas", () => {
  const upper = () => randomUUID().toUpperCase();
  const ref = { ...reference(), questionId: upper(), originRunId: upper() };
  const dispatch = factoryDispatchSchema.parse({
    binding: ref.binding,
    agentId: upper(),
    deviceRepoId: upper(),
  });
  const answer = pure.contextQuestionAnswerSchema.parse({
    reference: ref,
    answerId: upper(),
    facts: [{ kind: "request", sourceEventId: upper(), quote: "Keep it" }],
  });
  const escalation = pure.questionEscalationSchema.parse({
    reference: ref,
    eventId: upper(),
    reason: "Needs the owner",
  });
  const fact = answer.facts[0];
  assert.equal(fact.kind, "request");
  for (const id of [
    dispatch.agentId,
    dispatch.deviceRepoId,
    answer.answerId,
    answer.reference.questionId,
    answer.reference.originRunId,
    fact.kind === "request" ? fact.sourceEventId : "",
    escalation.eventId,
  ])
    assert.equal(id, id.toLowerCase());
  assert.equal(contextQuestionAnswerSchema, pure.contextQuestionAnswerSchema);
  assert.equal(serverDispatchSchema, factoryDispatchSchema);
});
