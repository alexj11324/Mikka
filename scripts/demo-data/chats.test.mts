import assert from 'node:assert/strict'
import test from 'node:test'
import { createParser } from '@openuidev/lang-core'
import { agentComponentCatalog, createAgentLibrary } from '../../lib/agent-ui-catalog.ts'
import { detectAgentUISource } from '../../lib/agent-ui-source.ts'
import { CHATS } from './chats.mjs'

const library = createAgentLibrary()
const placeholder = (text: string) => text.replace(/\{\{\w+:[\w-]+\}\}/g, '11111111-1111-4111-8111-111111111111')
const replies = Object.entries(CHATS).flatMap(([bot, messages]) => messages
  .filter(message => message.role === 'assistant')
  .map(message => ({ bot, ...detectAgentUISource(placeholder((message.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text).join('\n\n'))) }))
  .filter(reply => reply.isOpenUI))

test('every demo OpenUI reply parses without errors', () => {
  for (const { bot, source } of replies) {
    const parsed = createParser(library.toJSONSchema(), library.root).parse(source)
    assert.ok(parsed.root, bot)
    assert.deepEqual(parsed.meta.errors, [], `${bot}: ${source.slice(0, 80)}`)
    assert.deepEqual(parsed.meta.unresolved, [], bot)
  }
})

// Run with DEMO_DATA_COVERAGE=1 after adding components, so the demo keeps showing every one of them.
test('the demo replies use every component the bot can use', { skip: !process.env.DEMO_DATA_COVERAGE }, () => {
  const used = replies.map(reply => reply.source).join('\n')
  for (const name of Object.keys(agentComponentCatalog)) assert.match(used, new RegExp(`\\b${name}\\(`), name)
})
