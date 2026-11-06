import { createSessionClient, cleanupCase } from './cloud-startup.mjs'
const records = [{"sampleId": "58ef06e6_1", "title": "测试 1505 58ef06e6_1 claude_code", "issueId": "7c3c360b-dfab-462d-98e8-2a895824136b"}, {"sampleId": "58ef06e6_2", "title": "测试 1505 58ef06e6_2 codex", "issueId": "090bbb42-a75f-48cb-9636-c168be2f01ea"}, {"sampleId": "58ef06e6_3", "title": "测试 1505 58ef06e6_3 claude_code", "issueId": "cc76c7a5-f146-4384-8ead-3b292896b4ee"}, {"sampleId": "58ef06e6_4", "title": "测试 1505 58ef06e6_4 codex", "issueId": "8f84732e-4552-438d-83ac-6b9c849181ed"}, {"sampleId": "58ef06e6_5", "title": "测试 1505 58ef06e6_5 claude_code", "issueId": "557c22cf-9956-4af4-b0c6-9ac3a33d62ee"}, {"sampleId": "58ef06e6_6", "title": "测试 1505 58ef06e6_6 codex", "issueId": "8c1de3de-05ee-4889-863c-19be72329c10"}]
const expectedBot = 'bc925088-d87f-47b8-a786-c1c317ac005f'
const client = createSessionClient('https://app.aspectlylabs.com')
const post = body => ({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
let loggedIn = false
try {
  if(process.env.ACME_DEMO_EMAIL !== 'alex@acme.aspectlylabs.com') throw Error('cleanup_account_invalid')
  const response = await client.request('/api/auth/sign-in/email',post({email:process.env.ACME_DEMO_EMAIL,password:process.env.ACME_DEMO_PASSWORD,rememberMe:false}))
  if(!response.ok) throw Error('cleanup_login_failed')
  loggedIn = true
  await client.rpc('workspace.switchWorkspace',['de300001-ece6-4021-8214-c986ea306bde'])
  const bot = await client.json(`/api/bots/${expectedBot}`)
  if(bot.name !== '测试1505 云启动验收') throw Error('cleanup_bot_invalid')
  await client.rpc('coordinator.stopCoordinatorTurn',[expectedBot])
  for(const record of records) {
    await cleanupCase(client,record,'cloud')
    console.log(JSON.stringify({previousBatchCleanup:{issueId:record.issueId,...record.cleanup}}))
    if(record.cleanup.status!=='passed') throw Error('cleanup_incomplete')
  }
} finally {
  if(loggedIn) await client.request('/api/auth/sign-out',post({}))
  client.clear()
}
