/** Keyless acceptance transport only. Both persistent stores and every external
 * provider must be isolated before runtime may replace a logical destination. */
export function resourceControlledOrigin(env:NodeJS.ProcessEnv=process.env){
 const origin=env.MIKKA_RESOURCE_TEST_ORIGIN
 if(!origin)return null
 const target=new URL(origin)
 const databases=[env.MIKKA_DATABASE_URL,env.DATABASE_URL]
 if(env.CI!=='true'||target.origin!==origin||target.hostname!=='127.0.0.1'||target.protocol!=='http:'||
  databases.some(value=>{if(!value)return true;const db=new URL(value);return !['postgres:','postgresql:'].includes(db.protocol)||db.hostname!=='127.0.0.1'||!db.pathname.endsWith('_176')||Boolean(db.search||db.hash)})||
  ['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENAI_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','FIRECRAWL_API_KEY','TELEGRAM_BOT_TOKEN'].some(k=>env[k]))throw new Error('resourceControlledTransportInvalid')
 return origin
}
