test('a lifetime successor that loses the election is retried after the yielding candidate releases it', async () => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const children: ReturnType<typeof launch>[] = []
  const parent = context.run('parent', () => runDueTimer(token, {
    ...dependencies('parent'),
    handOff: async () => { trace.push('handoff:parent'); children.push(launch(`child-${children.length}`, 'parent')) },
  }))
  void parent.catch(() => {})
  let competitor: Promise<unknown> | undefined
  try {
    await flush()
    competitor = context.run('competing-candidate', () => runDueTimer(token, {
      ...dependencies('competing-candidate'),
      prepareClaim: async () => { enter(); await gate; return { mode: 'yield', wake: true } },
    }))
    await entered
    mock.timers.tick(lifetime)
    holders.get(token)!.wake()
    await flush()
    assert.equal(children.length, 1)
    assert.equal(children[0].finished(), true, 'the first successor lost the short election')
    assert.equal(holders.get(token)?.owner, 'parent')
    release()
    await competitor
    await flush()
    assert.equal(children.length, 2, 'the post-election wake must retry the legitimate handoff')
    assert.equal(holders.get(token)?.owner, 'child-1')
    await parent
    assert.equal(holders.has(token + ':claim'), false)
  } finally {
    release()
    if (competitor) await competitor
    await stop('parent', parent)
    for (const [index, child] of children.entries()) await stop(`child-${index}`, child.done)
  }
})
