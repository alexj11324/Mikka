import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../../.github/workflows/self-hosted-image.yml', import.meta.url), 'utf8')
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')

test('self-hosted image reuses a default-branch cache without trusting PR cache writes', () => {
  assert.match(workflow, /docker\/setup-buildx-action@[a-f0-9]{40}/)
  assert.match(workflow, /docker\/build-push-action@[a-f0-9]{40}/)
  assert.match(workflow, /load: true/)
  assert.match(workflow, /push: false/)
  assert.match(workflow, /tags: mikka-self-hosted:check/)
  const restore = workflow.match(/^\s*cache-from: (.*)$/m)?.[1] ?? ''
  const save = workflow.match(/^\s*cache-to: (.*)$/m)?.[1] ?? ''
  assert(restore.includes("github.event_name != 'pull_request'"), 'forks cannot restore owner cache')
  assert(restore.includes('github.event.pull_request.head.repo.full_name == github.repository'), 'only this repository PRs restore')
  assert(restore.includes('type=gha,scope=mikka-selfhost-public'))
  assert(save.includes("github.event_name == 'push'"), 'only main push may publish cache')
  assert(save.includes("github.ref == 'refs/heads/main'"))
  assert(save.includes('type=gha,scope=mikka-selfhost-public,mode=max'))
  assert(!workflow.includes('docker build --build-arg'), 'do not build the image twice')
  assert.match(workflow, /MIKKA_BUILD_REVISION=\$\{\{ github\.sha \}\}/)
  assert.match(workflow, /MIKKA_BUILD_WORKER_SHA=\$\{\{ steps\.image-inputs\.outputs\.worker-sha \}\}/)
})

test('cache is never the acceptance or the release artifact', () => {
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS subscription-workers/)
  assert.match(dockerfile, /RUN --mount=type=cache,id=mikka-pnpm/)
  for (const required of [
    'docker run --rm --network none', 'Start with an empty database',
    'Apply migrations and wait for health', 'Exercise the real daemon',
    'Build one packaged acceptance desktop', 'Verify the same persistent installation restarts',
    'Publish the tested revision',
  ]) assert(workflow.includes(required), required)
  assert(workflow.indexOf('Publish the tested revision') > workflow.indexOf('Verify the same persistent installation restarts'))
})
