import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { agentWebInstructions, createAgentWebTools, isPublicWebAddress, webUrlSchema } from '../lib/agent-web-tools.ts'

const signal = new AbortController().signal
const context = { toolCallId: 'test', messages: [], abortSignal: signal }

test('联网工具只暴露搜索和网页读取，保留 DS 聊天及认证', async () => {
  const tools = createAgentWebTools({ signal })
  assert.deepEqual(Object.keys(tools), ['web_search', 'read_webpage'])
  const source = await readFile(new URL('../app/api/agent/route.ts', import.meta.url), 'utf8')
  assert.match(source, /opencode\('deepseek-v4\.1-flash'\)/)
  assert.match(source, /auth\.api\.getSession/)
  assert.match(source, /tools:\s*\{[\s\S]*?\.\.\.createAgentWebTools\(\{ signal: request\.signal, authorize: async \(\) => \{ await authorizeModel[\s\S]*?await authorizePolicyTool\(session\.user\.id\) \} \}\),/)
  assert.match(source, /\.\.\.createComposioAITools\(\(action, input\) => \(async \(\) => \{ await authorizePolicyTool\(session\.user\.id\); return runComposioAction\(session\.user\.id, action, input\) \}\)\(\)\)/)
  assert.match(source, /stopWhen: isStepCount\(5\)/)
  assert.match(source, /stepNumber >= 4 \? \{ toolChoice: 'none' \}/)
  const instructions = agentWebInstructions(new Date('2026-10-21T00:00:00Z'))
  assert.match(instructions, /2026-10-21/)
  assert.match(instructions, /时区/)
  assert.match(instructions, /不可信数据/)
})

test('拒绝非 HTTPS、凭据、内网地址、IP 及自定义端口', () => {
  for (const url of ['http://example.org', 'https://user:pass@example.org', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://localhost', 'https://host.internal', 'https://site.local', 'https://example.org:8080']) {
    assert.equal(webUrlSchema.safeParse(url).success, false, url)
  }
  assert.equal(webUrlSchema.safeParse('https://www.weather.gov/').success, true)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '172.16.0.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '3fff::1', '2002:7f00:1::']) assert.equal(isPublicWebAddress(address), false, address)
  assert.equal(isPublicWebAddress('8.8.8.8'), true)
  assert.equal(isPublicWebAddress('2606:4700:4700::1111'), true)
})

test('搜索保留原始来源、日期和检索时间，裁剪内容', async () => {
  const tools = createAgentWebTools({ signal, run: async (operation, input, passedSignal) => {
    assert.equal(operation, 'search')
    assert.equal(input, '匹兹堡明天天气')
    assert.equal(passedSignal.aborted, false)
    return { results: [{ title: '预报', url: 'https://www.weather.gov/', snippet: '气象资料'.repeat(4000), date: '2026-10-21' }] }
  } })
  const output = await tools.web_search.execute({ query: '匹兹堡明天天气' }, context)
  assert.equal(output.ok, true)
  assert.equal(output.results[0].url, 'https://www.weather.gov/')
  assert.equal(output.results[0].date, '2026-10-21')
  assert.equal(output.results[0].snippet.length, 7000)
  assert.equal(output.untrustedContent, true)
  assert.ok(Date.parse(output.retrievedAt))
})

test('网页先检查 DNS，拒绝混合公共和私网解析', async () => {
  let calls = 0
  const tools = createAgentWebTools({ signal, resolve: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }], run: async () => { calls++; return {} } })
  const output = await tools.read_webpage.execute({ url: 'https://www.weather.gov/' }, context)
  assert.equal(output.ok, false)
  assert.equal(calls, 0)
})

test('网页只返回有效正文，不把重定向或上游错误当成资料', async () => {
  let output = { content: '网页资料', statusCode: 200 }
  const tools = createAgentWebTools({ signal, resolve: async () => [{ address: '8.8.8.8' }], run: async () => output })
  const valid = await tools.read_webpage.execute({ url: 'https://www.weather.gov/' }, context)
  assert.equal(valid.ok, true)
  assert.equal(valid.content, '网页资料')
  output = { content: 'redirect', statusCode: 302 }
  assert.equal((await tools.read_webpage.execute({ url: 'https://www.weather.gov/' }, context)).ok, false)
  output = { content: 'server failure', statusCode: 500 }
  assert.equal((await tools.read_webpage.execute({ url: 'https://www.weather.gov/' }, context)).ok, false)
})

test('计费验证未完成时说明具体原因且不重复调用上游', async () => {
  let calls = 0
  const tools = createAgentWebTools({ signal, run: async () => {
    calls++
    throw new Error('AI Gateway requires a valid credit card on file to service requests.')
  } })
  for (let i = 0; i < 3; i++) {
    const result = await tools.web_search.execute({ query: '天气' }, context)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'billing_required')
    assert.match(result.error, /管理员.*绑定支付卡/)
  }
  assert.equal(calls, 1)
})

test('上游失败不泄漏错误详情，限制每轮费用，取消传播', async () => {
  let calls = 0
  const tools = createAgentWebTools({ signal, run: async () => { calls++; throw new Error('secret upstream error') } })
  for (let i = 0; i < 5; i++) {
    const result = await tools.web_search.execute({ query: '天气' }, context)
    assert.equal(result.ok, false)
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
  assert.equal(calls, 4)
  const controller = new AbortController()
  controller.abort()
  const cancelled = createAgentWebTools({ signal: controller.signal, run: async () => { throw new Error('不应调用') } })
  await assert.rejects(cancelled.web_search.execute({ query: '天气' }, context), { name: 'AbortError' })
})
