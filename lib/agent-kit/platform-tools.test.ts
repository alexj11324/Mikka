import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AGENT_DEFINITION, builtinAgentDefinition, platformEffectiveTools } from './builtin'
import { AGENT_TOOL_IDS, BASELINE_PLATFORM_TOOL_IDS, COMPUTER_TOOL_IDS, PLATFORM_TOOL_ADDED, type AgentToolId } from './registry'
import { SCHEDULE_READ_TOOL_IDS } from '../coordinator/scheduled-read-tools'

const builtin = builtinAgentDefinition({ computerEnabled: true }).tools
const without = (...ids: AgentToolId[]) => DEFAULT_AGENT_DEFINITION.tools.filter(id => !ids.includes(id))
const BEFORE_GITHUB = '2026-11-02T16:42:00Z' // the production Coordinator's stored version 1
const AFTER_GITHUB = '2026-11-02T18:30:00Z'

test('every built-in tool is in the baseline or has an added-at entry, so none is added silently', () => {
  const baseline = new Set<string>(BASELINE_PLATFORM_TOOL_IDS)
  for (const id of builtin) assert.ok(baseline.has(id) || PLATFORM_TOOL_ADDED[id], `${id}: add it to PLATFORM_TOOL_ADDED in lib/agent-kit/registry.ts`)
  for (const [id, at] of Object.entries(PLATFORM_TOOL_ADDED)) {
    assert.ok(!baseline.has(id), `${id} is both baseline and added later`)
    assert.ok((builtin as readonly string[]).includes(id), `${id} has an added-at entry but is not a built-in tool`)
    assert.ok((AGENT_TOOL_IDS as readonly string[]).includes(id))
    assert.match(at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  }
  for (const id of BASELINE_PLATFORM_TOOL_IDS) assert.ok((builtin as readonly string[]).includes(id), `${id} left the built-in list`)
  assert.equal(PLATFORM_TOOL_ADDED.find_repository, '2026-11-02T15:23:48Z')
  assert.equal(PLATFORM_TOOL_ADDED.github_tools, '2026-11-02T18:24:20Z')
  assert.equal(PLATFORM_TOOL_ADDED.github_call, '2026-11-02T18:24:20Z')
})

test('已保存的旧定义也能拿到新的平台工具', () => {
  const old = without('github_tools', 'github_call')
  const stored = platformEffectiveTools({ source: 'builtin', createdAt: BEFORE_GITHUB, tools: old }, DEFAULT_AGENT_DEFINITION.tools)
  assert.deepEqual(stored, [...DEFAULT_AGENT_DEFINITION.tools])
  for (const source of ['user', 'improvement'] as const) {
    const edited = platformEffectiveTools({ source, createdAt: new Date(BEFORE_GITHUB), tools: old.filter(id => id !== 'web_search') }, DEFAULT_AGENT_DEFINITION.tools)
    assert.ok(edited.includes('github_tools') && edited.includes('github_call'), source)
    assert.equal(edited.includes('web_search'), false)
  }
})

test('a stored builtin copy follows the current built-in list and keeps computer tools it had', () => {
  const withComputer = [...without('find_repository'), ...COMPUTER_TOOL_IDS]
  assert.deepEqual(platformEffectiveTools({ source: 'builtin', createdAt: BEFORE_GITHUB, tools: withComputer }, DEFAULT_AGENT_DEFINITION.tools).sort(), [...DEFAULT_AGENT_DEFINITION.tools, ...COMPUTER_TOOL_IDS].sort())
  assert.deepEqual(platformEffectiveTools({ source: 'builtin', createdAt: BEFORE_GITHUB, tools: without('find_repository') }, builtin), [...builtin])
})

test('主人有意去掉的工具不会被加回来', () => {
  const after = platformEffectiveTools({ source: 'user', createdAt: AFTER_GITHUB, tools: without('github_tools', 'github_call') }, DEFAULT_AGENT_DEFINITION.tools)
  assert.deepEqual(after, without('github_tools', 'github_call'))
  // Saved after the baseline and before find_repository, without the baseline web_search.
  const saved = without('web_search', 'find_repository', 'github_tools', 'github_call')
  const tools = platformEffectiveTools({ source: 'user', createdAt: '2026-11-02T10:00:00Z', tools: saved }, DEFAULT_AGENT_DEFINITION.tools)
  assert.equal(tools.includes('web_search'), false)
  assert.ok(tools.includes('find_repository') && tools.includes('github_tools') && tools.includes('github_call'))
  // Mailbox joined on 2026-11-01; a version saved after that without it stays without it.
  assert.equal(platformEffectiveTools({ source: 'user', createdAt: '2026-11-02T10:00:00Z', tools: without('mailbox_send') }, DEFAULT_AGENT_DEFINITION.tools).includes('mailbox_send'), false)
  // An unknown creation time adds nothing.
  assert.deepEqual(platformEffectiveTools({ source: 'user', createdAt: undefined, tools: ['web_search'] }, DEFAULT_AGENT_DEFINITION.tools), ['web_search'])
})

test('ledger tools never join the scheduled read-only allowlist', () => {
  for (const id of ['github_tools', 'github_call', 'find_repository', 'call_app_tool', 'mailbox_send', 'schedule_create'] as const) {
    assert.equal((SCHEDULE_READ_TOOL_IDS as readonly string[]).includes(id), false, id)
  }
})
