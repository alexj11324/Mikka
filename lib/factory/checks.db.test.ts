// Real #192 migrations/store/dispatch/questions/claim and #193 consumers.
// Run production code over isolated PG; queue, actor and terminal reports are fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { freezeWorkerDefinition } from "../agent-kit/worker";
import { claimLocalRun } from "../computer/claim";
import { FactoryError } from "./contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from "./dispatch";
import { createFactoryClaim } from "./claim";
import { createFactoryQuestions, questionReference } from "./questions/store";
import { handleFactoryQuestion } from "./questions/http";
import { createFactoryReconciler } from "./reconcile";
import { factoryCheckIndependent } from "./check-independence";
import { configureFactoryCheck, factoryCheckAssignment, factoryCheckGates, factoryRepairBrief } from "./checks";
import { reconcileFactoryCheck } from "./reconcile-check";

test("actual migrated PG/HTTP: review/verify receipt consumers and bounded repair", { timeout: 120000 }, async t => {
  assert.equal(process.env.CI, "true", "Actions-only isolated test, no local application fallback");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.REQUIRE_DB, "1");
  const url = process.env.E2E_DATABASE_URL;
  assert.ok(url);
  assert.equal(process.env.DATABASE_URL, url);
  assert.equal(process.env.MIKKA_DATABASE_URL, url);
  const target = new URL(url);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "5432");
  assert.equal(target.username, "e2e");
  assert.equal(target.pathname, "/mikka_e2e");
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  assert.ok(["postgres:","postgresql:"].includes(target.protocol));
  const admin = new Pool({ connectionString: url });
  const schema = `factory193_consumers_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool | undefined;
  try {
    assert.equal(Math.floor(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 17);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
    const db = pool;
    const directory = new URL("../../drizzle/", import.meta.url);
    for (const file of orderMigrations((await readdir(directory)).filter(f => f.endsWith(".sql"))))
      await db.query(await readFile(new URL(file, directory), "utf8"));
    await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','check@example.invalid',true,now(),now()),('other','Other','other-check@example.invalid',true,now(),now())`);
    const authorize = async (user: string, issue: string, tx: import("pg").PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue,user])).rowCount === 1;
    const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),sha="a".repeat(40),command="node acceptance.mjs";
    await db.query(`INSERT INTO devices(id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable check device',now(),'[{"harness":"codex","installed":true}]')`,[deviceId]);
    await db.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Check fixture','codex',$2)`,[agentId,deviceId]);
    await db.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","verifyCommand") VALUES ($1,$2,'owner','/fixture/repo',$3)`,[repoId,deviceId,command]);
    const store=createFactoryStore(db,authorize,null,{independent:factoryCheckIndependent,gates:factoryCheckGates});
    const queue:FactoryQueue=async(tx,user,input,botId)=>{
      const id=randomUUID();
      await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Synthetic queue input, no provider')`,[id,user,input.issueId,input.agentId,deviceId,input.deviceRepoId,botId]);
      return {runId:id};
    };
    const dispatch=createFactoryDispatch(db,store,queue,{configure:{execute:factoryRepairBrief,review:configureFactoryCheck,verify:configureFactoryCheck},freeze:async(tx,_task,id)=>{
      const {rows:[run]}=await tx.query('SELECT prompt FROM agent_runs WHERE id=$1',[id]);
      await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',[id,JSON.stringify(freezeWorkerDefinition({harness:"codex",instructions:"Frozen fixture",prompt:run.prompt,parent:null,executionId:null}))]);
    }});
    const assignment=(tx:import("pg").PoolClient,task:FactoryTask,id:string)=>factoryCheckAssignment(tx,task.userId,id);
    const questions=createFactoryQuestions(db,authorize,store,dispatch,assignment);
    const claim=createFactoryClaim(store,questions,assignment);
    const reconcile=createFactoryReconciler(db,store,questions,{review:reconcileFactoryCheck,verify:reconcileFactoryCheck});
    async function pendingReview() {
      const issueId=randomUUID(),sourceEventId=randomUUID();
      await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Check fixture','{}','todo','normal')`,[issueId]);
      await db.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$1::text,'{"text":"Check original request"}')`,[sourceEventId]);
      let state=await store.route("owner",{issueId,sourceEventId,eventId:randomUUID(),rationale:"Check fixture",missingInformation:[],missingPermissions:[],needsSpec:false});
      const execute=await dispatch("owner",{binding:factoryBinding(state.task),agentId,deviceRepoId:repoId});
      await db.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$3 WHERE id=$1`,[execute.runId,`execute-${issueId}`,JSON.stringify({publish:{commit:sha},verify:{status:"passed"}})]);
      state=await store.apply("owner",execute.binding,randomUUID(),{action:"candidate",runId:execute.runId,candidate:{sha,repository:"/fixture/repo",environment:`device:${deviceId}`,scope:`issue:${issueId}`}});
      state=await store.apply("owner",factoryBinding(state.task),randomUUID(),{action:"finish",status:"passed",reason:"Synthetic execute completion",evidence:[{artifact:`run-report:${execute.runId}`,kind:"report",runId:execute.runId,sessionId:`execute-${issueId}`,candidateId:state.task.candidateId,sha,environment:`device:${deviceId}`,recordedAt:new Date().toISOString()}],output:{}});
      return store.apply("owner",factoryBinding(state.task),randomUUID(),{action:"advance",stage:"review",reason:"Independent review"});
    }
    const start=async(task:FactoryTask)=>dispatch("owner",{binding:factoryBinding(task),agentId,deviceRepoId:repoId});
    async function terminal(id:string,session:string,failed=false,edit?:(report:Record<string,any>)=>void) {
      const report={summary:"Synthetic terminal report",filesChanged:[],verify:{status:failed?"failed":"passed",command,exitCode:failed?17:0,signal:null,timedOut:false,output:failed?"ACTUAL_FIXTURE_EXIT_17":"FIXTURE_PASS"},check:{sha,readOnly:true},criteria:[{text:"Acceptance fixture",passed:!failed,evidence:"Original recorded observation"}],knownIssues:[],openQuestions:[],nextStep:null};
      edit?.(report);
      await db.query(`UPDATE agent_runs SET status=$2,"stopReason"='submitted',"sessionId"=$3,"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$4 WHERE id=$1`,[id,failed?"failed":"succeeded",session,JSON.stringify(report)]);
    }
    async function toolChunks(id:string,error=false,afterFinish=false) {
      const call=randomUUID();
      for (const [seq,chunk] of [[1,{type:"tool-input-available",toolName:"shell",toolCallId:call,input:{command}}],[2,{type:error?"tool-output-error":"tool-output-available",toolCallId:call,output:{exitCode:error?17:0,stdout:"Fixture child output"}}]] as const)
        await db.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") SELECT $1,$2,$3,$4,"finishedAt" + ($5::int * interval \'1 millisecond\') FROM agent_runs WHERE id=$2',[randomUUID(),id,seq,JSON.stringify(chunk),afterFinish?500:-500+seq]);
    }
    const state=(id:string)=>store.read("owner",id);
    await t.test("dispatch freezes exact assignment and real snapshot; actual local claim joins token transaction",async()=>{
      const r=await pendingReview(),d=await start(r.task),tx=await db.connect();
      try {
        await tx.query("BEGIN");
        const extras=await claim(tx,"owner",deviceId,d.runId,new Date(Date.now()+60000).toISOString());
        assert.equal(extras.baseBranch,sha);assert.equal(extras.verifyCommand,command);assert.deepEqual((extras.policy as any).networkAllow,[]);
        await tx.query("ROLLBACK");
      } finally {tx.release();}
      const tokenId=randomUUID();
      const guard=async(tx:import("pg").PoolClient)=>{await claim(tx,"owner",deviceId,d.runId,new Date(Date.now()+60000).toISOString());return true;};
      await assert.rejects(claimLocalRun(db,d.runId,deviceId,new Date(Date.now()+60000),undefined,guard,async tx=>{
        await tx.query('INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 minute\')',[tokenId,d.runId,"owner",randomUUID()]);throw new Error("Token callback rollback fixture");
      }),/rollback fixture/);
      assert.equal((await db.query('SELECT status FROM agent_runs WHERE id=$1',[d.runId])).rows[0].status,"queued");
      assert.equal((await db.query('SELECT count(*)::int n FROM run_tokens WHERE id=$1',[tokenId])).rows[0].n,0);
      assert.equal(await claimLocalRun(db,d.runId,deviceId,new Date(Date.now()+60000),undefined,guard,async tx=>{
        await tx.query('INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 minute\')',[tokenId,d.runId,"owner",randomUUID()]);
      }),"claimed");
      assert.equal((await db.query('SELECT count(*)::int n FROM run_tokens WHERE id=$1',[tokenId])).rows[0].n,1);
      await terminal(d.runId,`review-${r.task.id}`);await reconcile("owner");
      assert.equal((await state(r.task.id)).task.stage,"verify");
    });
    await t.test("separate review/verify pass reaches approval only with paired original verifier chunks",async()=>{
      const r=await pendingReview(),review=await start(r.task);
      await terminal(review.runId,`review-${r.task.id}`);await reconcile("owner");
      const verify=await start((await state(r.task.id)).task);
      await terminal(verify.runId,`verify-${r.task.id}`);await toolChunks(verify.runId);await reconcile("owner");
      const done=await state(r.task.id);assert.equal(done.task.stage,"approval");assert.equal(done.task.status,"pending");
      const evidence=done.attempts.find(a=>a.stage==="verify")!.evidence as any[];
      assert.equal(evidence.filter(e=>e.artifact.startsWith("run-chunk:")).length,2);
      assert.equal(new Set(done.attempts.filter(a=>a.runId).map(a=>a.sessionId)).size,3);
    });
    for(const mode of ["model-only","wrong-sha","missing-chunks","tool-error","post-finish-chunks","forged-failure"] as const)
      await t.test(`reject ${mode} without advance or automatic repair`,async()=>{
        const r=await pendingReview();let d=await start(r.task);
        if(mode==="missing-chunks"||mode==="tool-error"||mode==="post-finish-chunks") {await terminal(d.runId,`review-${r.task.id}`);await reconcile("owner");d=await start((await state(r.task.id)).task);}
        await terminal(d.runId,`negative-${r.task.id}`,mode==="forged-failure",report=>{if(mode==="model-only"||mode==="forged-failure")delete report.check;if(mode==="wrong-sha")report.check.sha="b".repeat(40);});
        if(mode==="tool-error")await toolChunks(d.runId,true);
        if(mode==="post-finish-chunks")await toolChunks(d.runId,false,true);
        await reconcile("owner");const result=await state(r.task.id);assert.equal(result.task.status,"blocked");assert.equal(result.attempts.filter(a=>a.stage==="execute").length,1);
      });
    for(const phase of ["review","verify"] as const) for(const failed of [false,true])
      await t.test(`${phase} trusted same-session human question resumes and ${failed?"repairs with original failure":"advances"}`,async()=>{
        const r=await pendingReview();let d=await start(r.task);
        if(phase==="verify") {await terminal(d.runId,`review-${r.task.id}`);await reconcile("owner");d=await start((await state(r.task.id)).task);}
        const session=`question-${r.task.id}`,questionId=randomUUID();
        await db.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,report=$3 WHERE id=$1`,[d.runId,session,JSON.stringify({question:{questionId,kind:"decision",question:"Which acceptance path?",options:["A","B"]}})]);
        const q=await questions.record("owner",d.runId);
        const server=createServer(async(req,res)=>{
          try {let body="";for await(const chunk of req)body+=chunk;
            const origin=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
            const result=await handleFactoryQuestion(questions,{actor:{userId:"owner",sessionId:"synthetic-browser-session"},authorization:null,method:req.method!,questionId:q.id,origin:req.headers.origin??null,url:origin,body:JSON.parse(body)});
            res.writeHead(result.status,{"content-type":"application/json"});res.end(JSON.stringify(result.body));
          }catch(error){res.writeHead(500);res.end(String(error));}
        });
        server.listen(0,"127.0.0.1");await once(server,"listening");
        let resumed:any;
        try {const origin=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
          const response=await fetch(origin,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({reference:questionReference(q),answerId:randomUUID(),text:"A"})});
          const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));resumed=result;
        } finally {server.close();await once(server,"close");}
        const tx=await db.connect();try{await tx.query("BEGIN");const extras=await claim(tx,"owner",deviceId,resumed.continuationRunId,new Date(Date.now()+60000).toISOString());assert.equal(extras.requireSessionResume,true);assert.equal(extras.resumeSessionId,session);assert.equal(extras.verifyCommand,command);await tx.query("ROLLBACK");}finally{tx.release();}
        await terminal(resumed.continuationRunId,session,failed);if(phase==="verify")await toolChunks(resumed.continuationRunId,failed);await reconcile("owner");
        const result=await state(r.task.id);
        assert.equal(result.attempts.find(a=>a.runId===d.runId)!.status,"waiting");
        if(failed) {
          assert.equal(result.task.stage,"execute");assert.equal(result.task.status,"pending");assert.equal(result.task.candidateId,null);
          const failedAttempt=result.attempts.find(a=>a.runId===resumed.continuationRunId)!;assert.equal(failedAttempt.status,"failed");assert.equal((failedAttempt.output.completion as any).verify.exitCode,17);
          const repair=await start(result.task);const {rows:[run]}=await db.query('SELECT prompt,"agentDefinition" FROM agent_runs WHERE id=$1',[repair.runId]);assert.match(run.prompt,new RegExp(failedAttempt.id));assert.match(run.prompt,/ACTUAL_FIXTURE_EXIT_17/);assert.ok(run.agentDefinition.promptDigest);
        }else assert.equal(result.task.stage,phase==="review"?"verify":"approval");
      });
    await t.test("unadopted retry, cancel and access loss reject before claim and token callback",async()=>{
      for(const mode of ["retry","cancel","access"] as const) {
        const r=await pendingReview(),d=await start(r.task);let id=d.runId;
        if(mode==="retry") {id=randomUUID();await db.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"retryOf") VALUES ($1,'owner',$2,$3,$4,'queued',$5)`,[id,r.task.issueId,agentId,deviceId,d.runId]);}
        if(mode==="cancel")await store.apply("owner",d.binding,randomUUID(),{action:"cancel",reason:"Cancel fixture"});
        if(mode==="access")await db.query('UPDATE issues SET "userId"=$2 WHERE id=$1',[r.task.issueId,"other"]);
        let tokens=0;
        const result=await claimLocalRun(db,id,deviceId,new Date(Date.now()+60000),undefined,async tx=>{try{await claim(tx,"owner",deviceId,id,new Date(Date.now()+60000).toISOString());return true;}catch(error){if(error instanceof FactoryError)return false;throw error;}},async()=>{tokens++;});
        assert.equal(result,"unavailable");assert.equal(tokens,0);
      }
    });
    await t.test("repair bound retains original failed attempt without dispatching another executor",async()=>{
      const r=await pendingReview(),d=await start(r.task);
      // Additional historical attempts are explicit fixtures; the real consumer counts them.
      for(let n=2;n<=4;n++)await db.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,'execute',$3,$4,'failed','Historical bounded repair fixture')`,[randomUUID(),r.task.id,n,n+1]);
      await terminal(d.runId,`bounded-${r.task.id}`,true);await reconcile("owner");
      const result=await state(r.task.id);assert.equal(result.task.stage,"review");assert.equal(result.task.status,"failed");assert.match(result.task.reason,/repair limit reached/);
      assert.equal(result.attempts.filter(a=>a.stage==="execute").length,4);
      assert.equal((result.attempts.find(a=>a.runId===d.runId)!.output.completion as any).verify.exitCode,17);
    });
  } finally {
    await pool?.end();
    // Preserve this schema until the existing disposable Actions service teardown.
    await admin.end();
  }
});
