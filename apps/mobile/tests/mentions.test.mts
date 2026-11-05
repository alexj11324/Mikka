import assert from 'node:assert/strict'
import test from 'node:test'
import { tasksShownByThreads } from '../lib/mentions.ts'

const run = 'de300000-2b09-4c5e-8a10-1234567890ab', task = 'ab300000-2b09-4c5e-8a10-1234567890ab', other = 'cd300000-2b09-4c5e-8a10-1234567890ab'
const sources = {
  [run]: { kind: 'run', id: run, name: 'x', agentName: 'Codex', harness: 'codex', status: 'running', issue: { id: task, identifier: 'ALEX-45', number: 45, title: '在 Mikka-handoff 创建 harmless 测试文件' } },
  [task]: { kind: 'issue', id: task, identifier: 'ALEX-45', number: 45, title: '在 Mikka-handoff 创建 harmless 测试文件', status: 'doing' },
  [other]: { kind: 'issue', id: other, identifier: 'ALEX-46', number: 46, title: '别的任务', status: 'todo' },
} as never

test('a reply citing a thread and its task draws one chip for that work', () => {
  const text = `开了线程 [[run:${run}]]，处理 [[issue:${task}]]，另外 [[issue:${other}]]`
  assert.deepEqual([...tasksShownByThreads(text, sources)], [task])
  assert.equal(tasksShownByThreads(`只有任务 [[issue:${task}]]`, sources).size, 0)
  assert.deepEqual([...tasksShownByThreads(`[[run:${run.toUpperCase()}]]`, sources)], [task])
})
