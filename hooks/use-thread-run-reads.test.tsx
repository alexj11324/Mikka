import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { act, StrictMode } from 'react'
import { Window } from 'happy-dom'

const calls: string[] = []
let epoch = 0
mock.module(new URL('../app/actions/artifacts.ts', import.meta.url).href, { namedExports: {
  listRunArtifacts: async (runId: string) => { calls.push('artifacts:' + runId); return [{ title: 'artifacts-' + epoch }] },
} })
mock.module(new URL('../app/actions/agents.ts', import.meta.url).href, { namedExports: {
  getThreadMachine: async (issueId: string, runId: string) => { calls.push('machine:' + issueId + ':' + runId); return { name: 'machine-' + epoch } },
} })

test('one read per opened resource, with fresh data on run transitions, reopen and account change', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { SWRConfig } = await import('swr')
  const { useRunArtifacts, useThreadMachine } = await import('./use-thread-run-reads')
  const node = browser.document.createElement('div') as unknown as HTMLDivElement
  const root = createRoot(node)
  const cache = () => new Map()
  function Header({ run, status, issue }: { run: string; status: string; issue: string }) {
    const artifacts = useRunArtifacts(run, status)
    const machine = useThreadMachine(issue, run, status)
    return <div>{artifacts.data?.[0]?.title} {machine.data?.name}</div>
  }
  function Cards({ run }: { run: string }) {
    const { data } = useRunArtifacts(run)
    return <output>{data?.[0]?.title}</output>
  }
  async function render(run: string | null, status: string, owner = 'one', issue = 'task') {
    calls.length = 0
    await act(async () => {
      root.render(<StrictMode><SWRConfig key={owner} value={{ provider: cache }}>
        {run && <><Header run={run} status={status} issue={issue} /><Cards run={run} /></>}
      </SWRConfig></StrictMode>)
    })
    // The standard SWR mount path schedules warm snapshots on the next frame.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) })
    if (run) {
      assert.deepEqual(calls.sort(), ['artifacts:' + run, 'machine:' + issue + ':' + run])
      assert.match(node.textContent ?? '', new RegExp('artifacts-' + epoch + ' machine-' + epoch))
      assert.equal(node.querySelector('output')?.textContent, 'artifacts-' + epoch)
    }
    epoch++
  }
  try {
    await render('one', 'running')
    await render('one', 'waiting')
    await render('one', 'running')
    await render('two', 'succeeded')
    await render(null, '')
    await render('two', 'succeeded')
    await render('two', 'succeeded', 'two')
    await render('two', 'running', 'two', 'other-task')
  } finally {
    await act(async () => root.unmount())
    await browser.happyDOM.close()
  }
})
