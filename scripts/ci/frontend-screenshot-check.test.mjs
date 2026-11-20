import assert from 'node:assert/strict'
import test from 'node:test'
import { hasScreenshot, isFrontendVisual, missingScreenshots } from './frontend-screenshot-check.mjs'

test('interface files need a screenshot and server files do not', () => {
  assert.equal(isFrontendVisual('components/settings/settings-view.tsx'), true)
  assert.equal(isFrontendVisual('messages/zh-CN.json'), true)
  assert.equal(isFrontendVisual('apps/mobile/app/(tabs)/settings/index.tsx'), true)
  assert.equal(isFrontendVisual('apps/desktop/src/renderer/styles.css'), true)
  assert.equal(isFrontendVisual('lib/settings-sections.ts'), false)
  assert.equal(isFrontendVisual('apps/api/src/index.ts'), false)
})

test('a real image or recording counts, a placeholder table does not', () => {
  assert.equal(hasScreenshot('See ![settings](https://github.com/user-attachments/assets/abc-123).'), true)
  assert.equal(hasScreenshot('<img alt="sidebar" src="https://private-user-images.githubusercontent.com/1/shot.png" />'), true)
  assert.equal(hasScreenshot('<video src="https://example.com/demo.mp4"></video>'), true)
  assert.equal(hasScreenshot('[常规](https://cursor.com/agents/run/artifacts?path=%2Fopt%2Fcursor%2Fartifacts%2Fsettings.png)'), true)
  assert.equal(hasScreenshot('<img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png">'), false)
  assert.equal(hasScreenshot('| Before | After |\n| --- | --- |\n| ... | ... |'), false)
  assert.equal(hasScreenshot('I looked at it locally.'), false)
  assert.equal(hasScreenshot('<!-- ![](https://example.com/hidden.png) --> nothing'), false)
})

test('an explicit opt-out needs a reason', () => {
  assert.equal(hasScreenshot('Screenshots: not needed: color token rename with no layout change.'), true)
  assert.equal(hasScreenshot('Screenshots: not needed: todo'), false)
})

test('only a frontend diff is blocked', () => {
  assert.deepEqual(missingScreenshots(['lib/settings-sections.ts'], ''), [])
  assert.deepEqual(missingScreenshots(['components/settings/settings-view.tsx'], 'no image'), ['components/settings/settings-view.tsx'])
  assert.deepEqual(missingScreenshots(['components/settings/settings-view.tsx'], '![nav](https://example.com/nav.png)'), [])
})
