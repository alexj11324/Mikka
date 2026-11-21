import assert from 'node:assert/strict'
import { test } from 'node:test'
import { grantReadsPersonalSkill, READ_PERSONAL_SKILL_TOOL } from '@/lib/plugins/skill-prompt'
import { AGENT_TOOL_IDS, PLATFORM_TOOL_ADDED } from '@/lib/agent-kit/registry'
import { platformEffectiveTools } from '@/lib/agent-kit/builtin'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'

// ALE-75 completion condition: "旧 execution 不因升级丢失正文能力（有测试）".
//
// The risk this holds: an execution's `effectiveTools` is frozen when it
// begins, so an execution started before this tool existed does not carry it.
// If the prompt had switched to metadata-only for everyone at deploy time,
// that execution would have had skills listed with no way to fetch a body —
// and the Coordinator has no filesystem tool, so nothing else could supply one.
// The prompt therefore keys on the grant, and this file holds that keying.

test('a grant without the tool cannot read a body', () => {
  // Every shape an execution frozen before ALE-75 can present.
  assert.equal(grantReadsPersonalSkill(undefined), false, 'no snapshot')
  assert.equal(grantReadsPersonalSkill([]), false, 'empty grant')
  assert.equal(grantReadsPersonalSkill(['load_skill']), false, 'load_skill does not read personal_skills')
  assert.equal(grantReadsPersonalSkill(['web_search', 'list_issues', 'stop_run']), false)
})

test('a grant with the tool can read a body', () => {
  assert.equal(grantReadsPersonalSkill([READ_PERSONAL_SKILL_TOOL]), true)
  assert.equal(grantReadsPersonalSkill(['load_skill', READ_PERSONAL_SKILL_TOOL]), true)
})

test('the tool is registered as a platform tool that joined after the baseline', () => {
  // A tool added to the built-in definition without a PLATFORM_TOOL_ADDED entry
  // would never reach an owner-chosen stored version; the reverse would let a
  // tool the person removed come back.
  assert.ok((AGENT_TOOL_IDS as readonly string[]).includes(READ_PERSONAL_SKILL_TOOL))
  const addedAt = PLATFORM_TOOL_ADDED[READ_PERSONAL_SKILL_TOOL]
  assert.ok(addedAt, 'read_personal_skill needs a PLATFORM_TOOL_ADDED entry')
  assert.match(addedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})

test('an execution frozen before the tool keeps its bodies instead of losing them', () => {
  // The rolling-upgrade case, end to end through the real version-compat layer:
  // a stored definition created before the tool joined gets it added at
  // execution; one created after with it absent had it removed on purpose.
  const before = '2026-11-11T04:00:00Z'
  const after = '2026-11-11T05:00:00Z'
  const withoutTool = DEFAULT_AGENT_DEFINITION.tools.filter(id => id !== READ_PERSONAL_SKILL_TOOL)

  const upgraded = platformEffectiveTools({ source: 'user', createdAt: before, tools: withoutTool }, DEFAULT_AGENT_DEFINITION.tools)
  assert.ok(upgraded.includes(READ_PERSONAL_SKILL_TOOL), 'a version from before the tool joined receives it')
  assert.equal(grantReadsPersonalSkill(upgraded), true, 'so its prompt may go metadata-only')

  const removedOnPurpose = platformEffectiveTools({ source: 'user', createdAt: after, tools: withoutTool }, DEFAULT_AGENT_DEFINITION.tools)
  assert.equal(removedOnPurpose.includes(READ_PERSONAL_SKILL_TOOL), false, 'a later version without it had it removed')
  assert.equal(grantReadsPersonalSkill(removedOnPurpose), false, 'so its prompt must still carry the bodies')
})

test('an unknown creation time adds nothing, and therefore keeps bodies', () => {
  // platformEffectiveTools returns the stored list untouched when it cannot date
  // the version. That execution may well lack the tool, so the prompt must not
  // assume it has one.
  const tools = platformEffectiveTools({ source: 'user', createdAt: undefined, tools: ['web_search'] }, DEFAULT_AGENT_DEFINITION.tools)
  assert.deepEqual(tools, ['web_search'])
  assert.equal(grantReadsPersonalSkill(tools), false)
})

test('the kill switch turns on-demand off, and off must mean the old prompt', async () => {
  // The failure this switch exists for is silent: a model that never calls the
  // tool produces a turn identical to a chat with no skills installed. So the
  // fallback must be behaviour-identical to pre-ALE-75, not "fewer tools".
  const { deploymentSwitch, overrideDeploymentSwitch } = await import('@/lib/deployment-switches')
  const on = deploymentSwitch('personalSkillOnDemand')
  overrideDeploymentSwitch('personalSkillOnDemand', false)
  try { assert.equal(deploymentSwitch('personalSkillOnDemand'), false) } finally { overrideDeploymentSwitch('personalSkillOnDemand', undefined) }
  assert.equal(deploymentSwitch('personalSkillOnDemand'), on)
  assert.equal(on, true, 'ships on')
})
