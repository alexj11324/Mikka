import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceFromCookie } from '../lib/workspace-cookie.ts'

// On web the saved workspace pick is the mikka-workspace cookie (saveWorkspace writes it); a pushed task's read
// compares against it, so a confirmed push can open on Expo Web too.
test('reads the web workspace pick from document.cookie', () => {
  const id = '6f1c2b8e-1f4a-4d1e-9a51-0b6c3c1d2e3f'
  assert.equal(workspaceFromCookie(`theme=dark; mikka-workspace=${id}; other=1`), id)
  assert.equal(workspaceFromCookie(`mikka-workspace=${id}`), id)
  assert.equal(workspaceFromCookie('theme=dark'), null)
  assert.equal(workspaceFromCookie(''), null)
  assert.equal(workspaceFromCookie('mikka-workspace='), null)
  assert.equal(workspaceFromCookie('xmikka-workspace=abc'), null)
  assert.equal(workspaceFromCookie('mikka-workspace=%E0%A4%A'), null)
})
