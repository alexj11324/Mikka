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

for (const [file, names] of [
  ['desktop-release.yml', ['APPLE_DEVELOPER_ID_P12_BASE64', 'APPLE_DEVELOPER_ID_P12_PASSWORD', 'APPLE_TEAM_ID', 'ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID']],
  ['mobile-native.yml', ['EXPO_TOKEN', 'ASC_API_KEY_P8', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID']],
]) test(file + ' reads the existing canonical platform names through OIDC, without static repository credentials', () => {
  const source = readFileSync(new URL('../.github/workflows/' + file, import.meta.url), 'utf8')
  assert.ok(!source.includes('secrets.'))
  assert.ok(source.includes('id-token: write'))
  assert.ok(source.includes('node scripts/release/apple-credentials.mjs'))
  for (const name of names) {
    const label = '- name: Read existing ' + name + ' through OIDC'
    const start = source.indexOf(label); assert.ok(start >= 0, name)
    const end = source.indexOf('\n      - ', start + label.length)
    const block = source.slice(start, end < 0 ? source.length : end)
    for (const text of ['method: oidc', 'identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', 'secret-path: /platform', 'secret-name: ' + name, 'recursive: false', 'include-imports: false']) assert.ok(block.includes(text), name + ':' + text)
  }
})
