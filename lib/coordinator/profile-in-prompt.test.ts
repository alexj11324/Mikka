import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instructionsWithMemory, promptWithCachedContext } from './prompt-parts'

// ALE-67: what Mikka learnt about the person is a section of the system prompt
// that takes part in the prompt cache, next to the person's own notes and never
// merged with them.

const PROFILE = '## What Mikka knows about the person\nMikka learnt these from the person\'s connected apps.\n- tool:\n  - Uses pnpm\n'

test('with no memory and no profile the instructions are unchanged', () => {
  assert.equal(instructionsWithMemory('base', ''), 'base')
  assert.equal(instructionsWithMemory('base', '', ''), 'base')
})

test('the person\'s own notes and what Mikka learnt are two named sections, notes first', () => {
  const both = instructionsWithMemory('base', '- Prefers Codex', PROFILE)
  assert.match(both, /^base\n\n## What the person asked you to remember\n- Prefers Codex\n\n## What Mikka knows about the person/)
  assert.ok(both.indexOf('asked you to remember') < both.indexOf('Mikka knows'), 'the person\'s own words come first')
  // Either can stand alone.
  assert.equal(instructionsWithMemory('base', '', PROFILE), `base\n\n${PROFILE}`)
  assert.match(instructionsWithMemory('base', '- a note', ''), /remember\n- a note$/)
})

test('the profile rides inside the cached prefix, not the per-turn tail', () => {
  const github = 'GitHub: the person is @octo.'
  const prepared = promptWithCachedContext('RULES', github, '- likes tea', '\nLIVE', PROFILE)
  const prefix = prepared.instructions.slice(0, prepared.stable)
  assert.ok(prefix.startsWith('RULES\nGitHub: '), 'the rules and repository lines still come first')
  assert.ok(!prefix.includes('likes tea') && !prefix.includes('Mikka knows'), 'memory and profile come after the cache breakpoint')
  assert.match(prepared.instructions.slice(prepared.stable), /^\n\n## What the person asked you to remember\n- likes tea\n\n## What Mikka knows about the person[\s\S]*\nLIVE$/)
  // Two turns with the same profile stay byte-identical up to the breakpoint.
  const again = promptWithCachedContext('RULES', github, '- likes tea', '\nOTHER', PROFILE)
  assert.equal(prefix, again.instructions.slice(0, again.stable))
  assert.equal(prepared.stable, again.stable)
})
