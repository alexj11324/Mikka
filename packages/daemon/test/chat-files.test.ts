import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withChatFiles } from '@mikka/protocol/chat-attachments'
import { Daemon } from '../src/main'
import { MemoryServer } from '../src/server-link'
import { makeRepo, tempDir, waitFor } from './helpers'

it('the real daemon materializes initial and live-input files before handing their paths to the harness', async () => {
  const server = new MemoryServer('files-device')
  server.addRepo('files-device', { repoId: 'files-repo', name: 'Files', path: await makeRepo() })
  const link = server.link(),
    dataDir = tempDir(),
    fixturesDir = tempDir()
  const bytes = Buffer.from('# 原始 Markdown\n\n```ts\nconst n = 42\n```\n')
  const file = {
    id: randomUUID(),
    name: '需求说明.md',
    size: bytes.length,
    mediaType: 'text/markdown',
    data: bytes.toString('base64'),
    text: bytes.toString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const downloads: string[] = []
  link.downloadChatFile = async (assignment, id) => {
    downloads.push(assignment.runId)
    expect(id).toBe(file.id)
    return file
  }
  writeFileSync(
    join(fixturesDir, 'files.jsonl'),
    [
      { t: 0, chunk: { type: 'start', messageId: 'files-message' } },
      { t: 3000, submit: { summary: 'File input received' } },
      { t: 3001, exit: { outcome: 'succeeded' } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  )
  const daemon = await new Daemon({
    dataDir,
    flavor: 'dev',
    agentSandbox: null,
    link,
    credential: 'fixture',
    harnesses: [{ harness: 'mock', installed: true, version: 'fixture' }],
    fixturesDir,
    mockSpeed: 1,
    heartbeatMs: 60_000,
    quotaSource: null,
  }).start()
  try {
    await daemon.syncWithServer()
    const runId = server.queueRun('files-device', {
      issueId: 'files-issue',
      repoId: 'files-repo',
      baseBranch: 'main',
      harness: 'mock',
      prompt: withChatFiles('读取文档', [file]),
      fixture: 'files',
    })
    await daemon.syncWithServer()
    const running = await waitFor(() => {
      const run = daemon.supervisor.get(runId)
      return run?.sessionId ? run : undefined
    })
    const state = JSON.parse(
      readFileSync(join(dataDir, 'adapters', `mock-${running.sessionId}.json`), 'utf8'),
    )
    expect(state.messages[0]).toContain('需求说明.md')
    expect(state.messages[0]).not.toContain('[mikka-file:')
    const original = join(dataDir, 'adapters', 'inputs', runId, `${file.id}.md`)
    expect(readFileSync(original)).toEqual(bytes)
    expect(state.messages[0]).toContain(original)
    await daemon.supervisor.send(runId, withChatFiles('再检查一次', [file]))
    await daemon.supervisor.idle()
    const transcript = JSON.stringify(server.chunksFor(runId))
    expect(transcript).toContain('再检查一次')
    expect(transcript).toContain(original)
    expect(downloads).toEqual([runId, runId])
  } finally {
    await daemon.stop()
  }
})
