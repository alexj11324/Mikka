import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import yaml from 'js-yaml'

test('all shared-account workflows retain pending requests, including expression-selected production groups', async () => {
  const directory = new URL('../../.github/workflows/', import.meta.url)
  const expressionFiles = new Set()
  let count = 0
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.yml'))) {
    const workflow = yaml.load(await readFile(new URL(file, directory), 'utf8'))
    const entries = [workflow.concurrency, ...Object.values(workflow.jobs ?? {}).map(job => job.concurrency)]
    for (const concurrency of entries) {
      const group = typeof concurrency === 'string' ? concurrency : concurrency?.group
      if (typeof group !== 'string' || !group.includes('production-smoke-owner-acceptance')) continue
      count++
      assert.equal(typeof concurrency, 'object', file + ': scalar concurrency cannot retain every pending request')
      assert.equal(concurrency['cancel-in-progress'], false, file)
      assert.equal(concurrency.queue, 'max', file + ': a default single pending request can cancel other workflows')
      if (group.includes('${{')) expressionFiles.add(file)
    }
  }
  assert.ok(count >= 12, 'cover workflow and job declarations across every production acceptance entry')
  for (const file of ['production-readiness.yml', 'read-cache-production.yml', 'self-hosted-production.yml']) {
    assert.ok(expressionFiles.has(file), file + ': preserve the PR-specific and shared production group branches')
  }
})
