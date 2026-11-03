import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatFileReference } from '@mikka/protocol/chat-attachments'
import { materializeChatFiles } from './chat-files'

describe('chat attachments delivered to an Agent', () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const bytes = Buffer.from('# Real Markdown\n\n中文内容\n')
  const file = {
    id,
    name: '../../需求.md',
    mediaType: 'text/markdown',
    size: bytes.length,
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    text: bytes.toString('utf8'),
  }
  it('materializes original and extracted bytes inside a host-selected directory and preserves retries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mikka-chat-files-'))
    try {
      const text = `Read these files\n${chatFileReference(file)}`
      const prompt = await materializeChatFiles(text, directory, async () => file)
      expect(prompt).toContain(join(directory, `${id}.md`))
      expect(await readFile(join(directory, `${id}.md`))).toEqual(bytes)
      expect(await readFile(join(directory, `${id}.extracted.txt`), 'utf8')).toEqual(file.text)
      expect(await materializeChatFiles(text, directory, async () => file)).toEqual(prompt)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('refuses changed identities, corrupted bytes and existing symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mikka-chat-files-'))
    try {
      const prompt = chatFileReference(file)
      await expect(
        materializeChatFiles(prompt, directory, async () => ({
          ...file,
          id: '10000000-0000-4000-8000-000000000002',
        })),
      ).rejects.toThrow('identity')
      await expect(
        materializeChatFiles(prompt, directory, async () => ({
          ...file,
          data: Buffer.from('changed').toString('base64'),
        })),
      ).rejects.toThrow('content')
      await symlink(join(directory, 'elsewhere'), join(directory, `${id}.md`))
      await expect(materializeChatFiles(prompt, directory, async () => file)).rejects.toThrow('unavailable')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
