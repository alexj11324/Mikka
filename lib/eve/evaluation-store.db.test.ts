import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {Pool} from 'pg'
import {assertE2eTarget} from '../../tests/helpers/e2e-target.mjs'
import {DEFAULT_AGENT_DEFINITION} from '../agent-kit/builtin'
import {makeSnapshot,digest} from '../agent-kit/definition'
import {CORE_EVAL_CASES} from '../agent-kit/evals'
import {createEvaluationBinding,loadEvaluationBinding,bindEvaluationSession,type EvaluationPlan} from './evaluation-store'

const database=process.env.E2E_DATABASE_URL
if(database)assertE2eTarget(database)

test('evaluation input bindings preserve owned proposal revisions and the frozen runtime',{skip:!database},async t=>{
 const schema='eve_eval_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:database})
 await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`})
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()})
 await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,UNIQUE(id,"workspaceId","ownerId"))`)
 await pool.query(await readFile(new URL('../../drizzle/20261027181000_agent_kit.sql',import.meta.url),'utf8'))
 await pool.query(await readFile(new URL('../../drizzle/20261112030501_eve_agent_kit_evaluations.sql',import.meta.url),'utf8'))
 const owner='eval-owner',bot=randomUUID(),workspace=randomUUID(),baseline=randomUUID(),candidate=randomUUID(),proposal=randomUUID(),evaluation=randomUUID(),request=randomUUID()
 const scope={ownerId:owner,botId:bot,workspaceId:workspace,surface:'web' as const}
 const agent={...DEFAULT_AGENT_DEFINITION,tools:['web_search'] as typeof DEFAULT_AGENT_DEFINITION.tools}
 const snapshot=makeSnapshot(baseline,1,agent,'Frozen host',{harness:'ai_sdk',model:'fixture-model'})
 const plan:EvaluationPlan={scope,snapshot,testCase:CORE_EVAL_CASES[0],instructions:'Frozen instructions',tools:[]}
 await pool.query('INSERT INTO "user" VALUES($1)',[owner]);await pool.query('INSERT INTO bots VALUES($1,$2,$3)',[bot,owner,workspace])
 await pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,bot_id,workspace_id) VALUES($1,$2::text,$2::uuid,$3)',[owner,bot,workspace])
 for(const [id,version,definition] of [[baseline,1,agent],[candidate,2,{...agent,instructions:'Candidate guidance'}]] as const)await pool.query(`INSERT INTO agent_kit_versions(id,owner_id,bot_key,version,definition,digest,source,request_key) VALUES($1::uuid,$2,$3,$4,$5,$6,'builtin',$1::text)`,[id,owner,bot,version,definition,digest(definition)])
 await pool.query(`INSERT INTO agent_kit_proposals(id,owner_id,bot_key,baseline_id,candidate_id,request_key,evidence,rationale) VALUES($1::uuid,$2,$3,$4,$5,$1::text,'[]','fixture')`,[proposal,owner,bot,baseline,candidate])
 await pool.query(`INSERT INTO agent_kit_evaluations(id,owner_id,bot_key,proposal_id,request_key,mode) VALUES($1,$2,$3,$4,$5,'live')`,[evaluation,owner,bot,proposal,request])
 await pool.query(`INSERT INTO agent_kit_executions(id,owner_id,bot_key,execution_key,version_id,snapshot) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),owner,bot,'evaluation:'+request,baseline,snapshot])
 const id=await createEvaluationBinding(pool,scope,evaluation,baseline,plan)
 await bindEvaluationSession(pool,id,'native-evaluation-session')
 assert.equal((await loadEvaluationBinding(pool,scope,id))?.session_id,'native-evaluation-session')
 await assert.rejects(bindEvaluationSession(pool,id,'different-session'),/agentEvaluationMismatch/)
 for(const foreign of [{...scope,ownerId:'other'},{...scope,botId:randomUUID()},{...scope,workspaceId:randomUUID()}])assert.equal(await loadEvaluationBinding(pool,foreign,id),null)
 const candidatePlan={...plan,snapshot:makeSnapshot(candidate,2,{...agent,instructions:'Candidate guidance'},snapshot.hostInstructions,snapshot.runtime)}
 assert.ok(await createEvaluationBinding(pool,scope,evaluation,candidate,candidatePlan))
 for(const changed of [{...plan,snapshot:{...snapshot,runtime:{harness:'ai_sdk' as const,model:'wrong-model'}}},{...plan,snapshot:{...snapshot,definition:{...agent,instructions:'changed'}}},{...plan,snapshot:{...snapshot,hostInstructionsDigest:'0'.repeat(64)}}])await assert.rejects(createEvaluationBinding(pool,scope,evaluation,baseline,changed),/agentEvaluationMismatch/)
 await pool.query("UPDATE agent_kit_evaluations SET status='completed' WHERE id=$1",[evaluation])
 await assert.rejects(createEvaluationBinding(pool,scope,evaluation,baseline,plan),/agentEvaluationMismatch/)
 assert.equal((await loadEvaluationBinding(pool,scope,id))?.session_id,'native-evaluation-session','terminal cleanup remains readable')
})
