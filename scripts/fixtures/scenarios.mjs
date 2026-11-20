import { createHash } from 'node:crypto'

export const FIXTURE_TIME = '2026-11-20T12:00:00.000Z'
export const FIXTURE_SCENARIOS = ['empty', 'board', 'task', 'automations', 'bot-settings', 'pulls']
export function fixtureId(scene, key) {
  const hex = createHash('sha256').update(`mikka-ui-fixture-v1:${scene}:${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
export function fixtureScenario(name) {
  if (!FIXTURE_SCENARIOS.includes(name)) throw new Error('FIXTURE_SCENARIO_UNKNOWN')
  const id = key => fixtureId(name, key)
  const workspaceId = id('workspace'), userId = id('user'), botId = id('bot'), taskId = id('task-review')
  const query = new URLSearchParams({ workspace: workspaceId, section: ['empty', 'board', 'task'].includes(name) ? 'all-issues'
    : name === 'bot-settings' ? 'coordinator' : name })
  if (name === 'task') query.set('issue', taskId)
  if (name === 'bot-settings') query.set('bot', botId)
  return { name, id, userId, workspaceId, botId, taskId, automationId: id('automation-0'),
    email: `fixture-${name}@mikka.invalid`, path: `/mikka/zh-CN/?${query}`, time: FIXTURE_TIME }
}
