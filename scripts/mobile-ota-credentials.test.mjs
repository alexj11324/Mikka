import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../.github/workflows/mobile-update.yml', import.meta.url), 'utf8')
const delivery = workflow.slice(workflow.indexOf('- name: Read the existing production Expo credential'), workflow.indexOf('- name: Publish to production'))
test('production OTA obtains only the existing named token through the immutable main workload identity', () => {
  for (const required of ["github.event_name == 'push'", "github.ref == 'refs/heads/main'", "github.repository_id == '1427517699'", "github.repository_owner_id == '183887963'", 'method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'env-slug: prod', 'secret-path: /platform', 'secret-name: EXPO_TOKEN', 'recursive: false', 'include-imports: false']) assert.ok(delivery.includes(required), required)
  assert.ok(!delivery.includes('secrets.EXPO_TOKEN'))
})
test('a PR preview cannot acquire the production OIDC delivery', () => {
  const preview = workflow.slice(workflow.indexOf('- name: Publish to pr-'))
  assert.ok(preview.includes("github.event_name == 'pull_request'"))
  assert.ok(preview.includes('github.event.pull_request.head.repo.full_name == github.repository'))
  assert.ok(!preview.includes('method: oidc'))
  const beforeDelivery = workflow.slice(0, workflow.indexOf('- name: Read the existing production Expo credential'))
  assert.ok(!beforeDelivery.includes('secrets.EXPO_TOKEN'), 'the production job must not inherit a static GitHub token')
})
