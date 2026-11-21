import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { MODEL_ROUTING_EFFORTS, modelTier, supportedModelEfforts } from './model-routing'

test('exact model tiers leave unknown versions and aliases at standard', () => {
  for (const model of ['claude-haiku-5-5', 'gpt-6-luna', 'deepseek-flash']) assert.equal(modelTier(model), 'light')
  for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-6-astra']) assert.equal(modelTier(model), 'strongest')
  for (const model of ['claude-sonnet-5-5', 'unreported-opus', 'gpt-99-luna', 'constructor', '__proto__']) assert.equal(modelTier(model), 'standard')
})

test('offered efforts exist in the retained native capability reports and run protocol', () => {
  const claude = JSON.parse(readFileSync(new URL('../packages/daemon/test/fixtures/claude-code-2.1.309-initialize.json', import.meta.url), 'utf8'))
  for (const row of claude.response.response.models) {
    const offered = supportedModelEfforts(row.resolvedModel, 'claude_code')
    assert.ok(offered.length)
    for (const effort of offered) assert.ok(row.supportedEffortLevels.includes(effort))
  }
  const codex = JSON.parse(readFileSync(new URL('../packages/daemon/test/fixtures/codex-0.163.0-model-list.json', import.meta.url), 'utf8'))
  for (const row of codex.result.data) {
    const reported = row.supportedReasoningEfforts.map((item: { reasoningEffort: string }) => item.reasoningEffort)
    const offered = supportedModelEfforts(row.id, 'codex')
    assert.ok(offered.length)
    for (const effort of offered) assert.ok(reported.includes(effort) && MODEL_ROUTING_EFFORTS.includes(effort))
    assert.ok(!(offered as readonly string[]).includes('ultra'))
  }
  for (const [model, harness] of [['deepseek-flash', 'codex'], ['claude-haiku-5-5', 'codex'], ['gpt-6-luna', 'claude_code'], ['new-model', 'codex'], ['__proto__', 'claude_code']] as const) {
    assert.deepEqual(supportedModelEfforts(model, harness), [])
  }
})
