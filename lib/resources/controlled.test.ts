import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resourceControlledOrigin} from './controlled'
test('keyless resource transport requires isolated origin and both PG stores, and rejects real provider configuration',()=>{
 const safe={CI:'true',MIKKA_RESOURCE_TEST_ORIGIN:'http://127.0.0.1:6183',MIKKA_DATABASE_URL:'postgresql://postgres@127.0.0.1:55479/resources_app_176',DATABASE_URL:'postgresql://postgres@127.0.0.1:55479/resources_workspace_176'}
 assert.equal(resourceControlledOrigin({}),null)
 assert.equal(resourceControlledOrigin(safe),safe.MIKKA_RESOURCE_TEST_ORIGIN)
 for(const key of ['VERCEL','AI_GATEWAY_API_KEY','DECISION_GATEWAY_API_KEY','OPENAI_API_KEY','OPENCODE_API_KEY','COMPOSIO_API_KEY','FIRECRAWL_API_KEY','TELEGRAM_BOT_TOKEN'])assert.throws(()=>resourceControlledOrigin({...safe,[key]:'synthetic'}),/Invalid/)
 for(const changed of [{CI:'false'},{MIKKA_RESOURCE_TEST_ORIGIN:'https://example.org'},{MIKKA_RESOURCE_TEST_ORIGIN:'http://127.0.0.1:6183/?target=external'},...['MIKKA_DATABASE_URL','DATABASE_URL'].flatMap(key=>[
  {[key]:'postgresql://postgres@external.invalid/database_176'},
  {[key]:'postgresql://postgres@127.0.0.1/production'},
  {[key]:'postgresql://postgres@127.0.0.1/resources_176?host=external.invalid'},
  {[key]:undefined},
 ])])assert.throws(()=>resourceControlledOrigin({...safe,...changed}),/Invalid/)
})
