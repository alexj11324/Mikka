import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/ui-policy.yml', import.meta.url), 'utf8')
const docs = readFileSync(new URL('../../docs/dev-workflow.md', import.meta.url), 'utf8')
const guard = "(github.event_name != 'pull_request' || github.event.pull_request.draft != true)"
function job(name) {
  const sections = workflow.split('\njobs:\n')[1].split(/\n(?=  [a-z][a-z0-9-]+:\n)/)
  const result = sections.find(section => section.startsWith('  ' + name + ':\n'))
  assert.ok(result, 'existing job missing: ' + name)
  return result
}

test('draft and ready transitions are both observed', () => {
  assert.match(workflow, /pull_request:\n    types: \[opened, reopened, synchronize, ready_for_review, converted_to_draft\]/)
  assert.match(workflow, /merge_group:/)
  assert.match(workflow, /push:\n    branches: \[main\]/)
})

test('heavy selected jobs defer for draft PRs but retain non-PR execution', () => {
  for (const name of ['ui-policy-full', 'ui-policy-integrations', 'source-checks', 'daemon-checks', 'analytics-checks', 'workspace-governance-checks', 'browser-tests-full']) {
    const source = job(name)
    assert.ok(source.includes(guard), name + ' must exclude draft PRs')
    assert.ok(source.includes('needs: changes'), name + ' must preserve trusted source selection')
  }
})

test('both required aggregation checks execute and fail explicitly on drafts', () => {
  for (const [name, label] of [['ui-policy', 'UI policy (strict)'], ['browser-tests', 'Production build and browser interactions']]) {
    const source = job(name)
    assert.ok(source.includes('name: ' + label))
    assert.ok(source.includes('if: ${{ !cancelled() }}'), name + ' must still run on draft')
    assert.ok(source.includes("if: github.event_name == 'pull_request' && github.event.pull_request.draft == true"))
    assert.match(source, /Draft PR is not a validated merge candidate[\s\S]*?exit 1/)
    assert.match(source, /Require every selected/)
  }
})

test('local red-green before final CI stays documented', () => {
  assert.match(docs, /CI is the final gate/)
  assert.match(docs, /Development loop:[\s\S]*?red→green/)
  assert.match(docs, /Ready for review/)
})
