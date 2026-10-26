/** Executes the formal schedule runtime in a guarded disposable process. */
import {registerHooks} from 'node:module'
async function main(){
 const db=process.env.MIKKA_DATABASE_URL
 if(process.env.CI!=='true'||!process.env.MIKKA_RESOURCE_TEST_ORIGIN||!db||new URL(db).hostname!=='127.0.0.1'||!new URL(db).pathname.endsWith('_176')||['AI_GATEWAY_API_KEY','OPENAI_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','VERCEL'].some(k=>process.env[k]))throw new Error('isolated schedule model worker only')
 const hooks=registerHooks({resolve(specifier,context,next){return specifier==='server-only'?{url:'data:text/javascript,export{}',shortCircuit:true}:next(specifier,context)}})
 const {schedules}=await import('../../lib/schedules/runtime')
 console.log(JSON.stringify({phase:'formal scheduled model worker',pid:process.pid}))
 try{await schedules().tick();console.log(JSON.stringify({phase:'formal scheduled model tick complete'}))}
 finally{
  const {pool}=await import('../../lib/db')
  const {workspacePool}=await import('../../lib/workspace-db')
  await pool.end();await workspacePool.end();hooks.deregister()
 }
}
main().catch(error=>{console.log(JSON.stringify({phase:'formal scheduled model tick failed',code:error instanceof Error?error.name:'unknown'}));process.exitCode=1})
