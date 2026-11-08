import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { screenshotIdentity, pngDimensions, loginFlow, workspaceFlow, readFlow, SHOTS } from './mobile-screenshots.mjs'

const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
  GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', OVERLAY_SHA: 'b'.repeat(40) }

test('manual main identity and full overlay revision are required before credentials', () => {
  assert.equal(screenshotIdentity(env).sha, env.GITHUB_SHA)
  for (const patch of [{ GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REPOSITORY: 'fork/Mikka' }, { GITHUB_REPOSITORY_ID: 'other' },
    { GITHUB_REPOSITORY_OWNER_ID: 'other' }, { OVERLAY_SHA: 'main' }, { OVERLAY_SHA: 'b'.repeat(39) }]) {
    assert.throws(() => screenshotIdentity({ ...env, ...patch }))
  }
})

test('PNG validation accepts only the actual full-resolution capture size', () => {
  const png = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
  png.write('IHDR', 12)
  png.writeUInt32BE(1320, 16)
  png.writeUInt32BE(2868, 20)
  assert.deepEqual(pngDimensions(png), { width: 1320, height: 2868 })
  png.writeUInt32BE(1290, 16)
  assert.throws(() => pngDimensions(png))
})

test('only login inputs use secret placeholders and post-authentication flows only navigate and wait', () => {
  const login = loginFlow()
  assert.match(login, /inputText: \$\{MAESTRO_REVIEW_PASSWORD\}/)
  assert.match(login, /id: signin-submit/)
  const flow = readFlow('mikka://task/demo/conversation', 'Checklist')
  assert.doesNotMatch(flow, /inputText|tapOn|runScript|evalScript|http|launchApp/)
  assert.throws(() => readFlow('https://example.com', 'Demo'))
  assert.equal(SHOTS.length, 5)
  assert.match(workspaceFlow(), /tapOn: Mikka Demo/)
  assert.doesNotMatch(workspaceFlow(), /inputText|runScript|http/)
})

test('workflow credentials follow source and CI validation and exports remain allowlisted', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/mobile-screenshots.yml', import.meta.url), 'utf8')
  const source = workflow.indexOf('run: node scripts/release/mobile-screenshots.mjs source')
  const credential = workflow.indexOf('uses: Infisical/secrets-action@')
  assert.ok(source > 0 && credential > source)
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/)
  assert.doesNotMatch(workflow, /pull_request:|push:|secrets\.|continue-on-error/)
  assert.equal((workflow.match(/secret-name:/g) ?? []).length, 3)
  assert.match(workflow, /secret-name: APP_STORE_REVIEW_EMAIL/)
  assert.match(workflow, /secret-name: APP_STORE_REVIEW_PASSWORD/)
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/mikka-app-store-export\//)
  assert.ok(workflow.indexOf('Build unsigned Release') < workflow.indexOf('Read existing review email'))
  const build = readFileSync(new URL('./mobile-screenshots-build.sh', import.meta.url), 'utf8')
  assert.match(build, /CODE_SIGNING_ALLOWED=NO/)
  assert.match(build, /Set :EXUpdatesEnabled false/)
})
