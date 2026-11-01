import {tool,zodSchema,jsonSchema} from 'ai'
import {z} from 'zod'
import { bindingSchema,routeSchema } from '@/lib/factory/contract'
import {factoryDispatchSchema} from '@/lib/factory/dispatch-schema'
import {contextQuestionAnswerSchema,questionEscalationSchema,questionReferenceSchema} from '@/lib/factory/questions/schema'
import {commandSchema,skillEvaluationCommandSchema} from '@/lib/self-improvement/schema'
import type {NativeToolScope} from './tool-scope'
import * as steps from './steps'
const coordinatorQuestionReferenceSchema = questionReferenceSchema.pick({ questionId: true, questionRevision: true })
const skillEvaluationInput = zodSchema(skillEvaluationCommandSchema)
export function factoryCoordinatorTools(userId:string,scope?:NativeToolScope){const id=z.uuid();return {
list_factory_requests: tool({
      description: 'Read recent authenticated requests to identify the source event for task routing.',
      inputSchema: z.object({}), execute: () => steps.listFactoryRequests(userId, scope),
    }),
create_issue_from_request: tool({
      description: 'Create one personal issue from an actual authenticated user request when it needs a new task. Use the sourceEventId from list_factory_requests and a concise title; the server copies the original request into the description. Replaying the same source returns its existing accessible issue. Use the returned issueId for Factory routing.',
      inputSchema: z.object({ sourceEventId: id, title: z.string().trim().min(1).max(200) }).strict(),
      execute: input => steps.createIssueFromRequestStep(userId, input, scope),
    }),
route_factory_task: tool({
      description: 'Persist routing for the request and issue. Clear authorized work starts execute. Record only material missing information/permissions; spec is optional.',
      inputSchema: routeSchema.omit({ eventId: true }), execute: ( input) => steps.routeFactoryTask(userId, input, scope),
    }),
get_factory_task: tool({
      description: 'Read durable routing, current binding, reasons, runs, attempts, candidate and evidence.',
      inputSchema: z.object({ taskId: id }), execute: ( input) => steps.getFactoryTask(userId, input, scope),
    }),
list_factory_questions: tool({
      description:
        'Read durable execution questions and their original task/run/session after restart. Never infer waiting solely from model memory.',
      inputSchema: z.object({ taskId: id.optional() }),
      execute: (input) => steps.listFactoryQuestions(userId, input, scope),
    }),
get_factory_question: tool({
      description:
        'Read a durable question, current fence, reason and continuation state.',
      inputSchema: z.object({ questionId: id }),
      execute: (input) => steps.getFactoryQuestion(userId, input, scope),
    }),
answer_factory_context: tool({
      description:
        'Resolve only a context question using exact excerpts from accessible issue/request facts. This cannot answer a decision/permission or grant authorization.',
      inputSchema: contextQuestionAnswerSchema.extend({ reference: coordinatorQuestionReferenceSchema }),
      execute: (input) => steps.answerFactoryContext(userId, input, scope),
    }),
escalate_factory_question: tool({
      description:
        'Escalate the actual unresolved information, decision, permission or external condition after checking available facts. Does not cancel the task or authorize anything.',
      inputSchema: questionEscalationSchema.extend({ reference: coordinatorQuestionReferenceSchema }),
      execute: (input) => steps.escalateFactoryQuestion(userId, input, scope),
    }),
answer_factory_question_from_user: tool({
      description:
        'Relay an actual subsequent authenticated browser user_message to its question. The backend derives the verbatim answer and checks provenance/ambiguity; model text and delegated messages cannot become human approval.',
      inputSchema: z
        .object({
          reference: coordinatorQuestionReferenceSchema,
          answerId: id,
          sourceEventId: id,
        })
        .strict(),
      execute: (input) => steps.answerFactoryQuestionFromUser(userId, input, scope),
    }),
resolve_factory_task: tool({
      description: 'Record only the missing items answered by a subsequent actual user request. Actual run permissions are checked again at dispatch.',
      inputSchema: z.object({ binding: bindingSchema, sourceEventId: id, rationale: z.string().min(1).max(4000), missingInformation: z.array(z.string().min(1).max(4000)).max(20), missingPermissions: z.array(z.string().min(1).max(4000)).max(20), needsSpec: z.boolean(), }),
      execute: ( input) => steps.resolveFactoryTask(userId, input, scope),
    }),
stop_factory_task: tool({
      description: 'Cancel the task or record withdrawn permission; stop bound runs and block later events.',
      inputSchema: z.object({ binding: bindingSchema, reason: z.string().min(1).max(4000), action: z.enum(['cancel','revoke']), }), execute: ( input) => steps.stopFactoryTask(userId, input, scope),
    }),
dispatch_factory_run: tool({
      description: 'Queue and bind one Factory run atomically. Use the exact current pending binding from route_factory_task/get_factory_task. Waiting, cancelled, revoked or stale tasks cannot dispatch. Reuse the same binding after a lost response.',
      inputSchema: factoryDispatchSchema,
      execute: ( input) => steps.dispatchFactoryRunStep(userId, input, scope),
    }),
select_baseline_skill: tool({
      description:'When the person requests a controlled Skill rehearsal, explicitly select the built-in baseline for an existing queued run before claim. This does not activate a candidate, grant permissions or prove execution.',
      inputSchema:z.object({runId:id}).strict(), execute:input=>steps.selectBaselineSkill(userId, input, scope),
    }),
select_active_skill: tool({
      description:'Select the currently approved active Skill for an owned queued run. The server resolves the authorized version; withdrawn versions and arbitrary candidate versions cannot be selected.',
      inputSchema:z.object({runId:id}).strict(), execute:input=>steps.selectActiveSkill(userId, input, scope),
    }),
register_skill_candidate: tool({
      description:'Register canonical Skill bytes from the exact committed Factory candidate linked to a failure-derived proposal. Supply only the existing current binding and proposal ID. Registration does not activate or approve the Skill.',
      inputSchema:commandSchema.options[5].omit({action:true}), execute:input=>steps.registerSkillCandidate(userId, input, scope),
    }),
skill_evaluation: tool({
      description:'Freeze the server-owned report benchmark from an actual baseline run; dispatch one pending training run, bind evaluation to a registered candidate, dispatch one pending heldout run, or compare real persisted results. Settings and cases stay server-owned; comparison cannot activate a Skill or grant approval.',
      inputSchema:jsonSchema({ ...skillEvaluationInput.jsonSchema, type: 'object' }, { validate: skillEvaluationInput.validate }), execute:input=>steps.skillEvaluation(userId,input,scope),
    }),
dispatch_baseline_rehearsal: tool({
      description:'For an explicitly requested controlled Skill rehearsal, atomically dispatch an existing authorized pending Factory execute task with the built-in baseline selected before any worker can claim it. Does not activate a candidate or grant permissions.',
      inputSchema:commandSchema.options[4].omit({action:true}),execute:input=>steps.dispatchBaselineRehearsal(userId, input, scope),
    }),
record_run_feedback: tool({
      description:'Record feedback for an owned finished run. Feedback is always an untrusted signal; never use it as truth, permission or an approval.',
      inputSchema:commandSchema.options[0].omit({action:true}), execute:input=>steps.recordRunFeedback(userId, input, scope),
    }),
propose_skill_improvement: tool({
      description:'Aggregate existing failure signals using the fixed server trigger and return an offline proposal. Cannot alter scorer, benchmark, policy, budget or thresholds.',
      inputSchema:z.object({runId:id}).strict(), execute:input=>steps.proposeSkillImprovement(userId, input, scope),
    }),
get_run_improvements: tool({
      description:'Read authorized immutable scoring and offline proposals, including explicit assigned/unrecorded provenance. Assignment is not proof of Harness execution.',
      inputSchema:z.object({runId:id}).strict(), execute:input=>steps.readRunImprovements(userId, input, scope),
    }),
handoff_skill_improvement: tool({
      description:'Bind a source-verified proposal to an already authorized pending Factory execute task. It runs through existing independent review/verification and human approval; this never activates or publishes the candidate.',
      inputSchema:commandSchema.options[3].omit({action:true}), execute:input=>steps.handoffSkillImprovement(userId, input, scope),
    }),
get_skill_improvement_factory: tool({
      description:'Read the linked existing Factory task and gate status for a proposal. No tool can mark review, verification or human approval passed.',
      inputSchema:z.object({proposalId:id}).strict(), execute:input=>steps.getSkillImprovementFactory(userId, input, scope),
    })
}}
