import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

test('attachment links use the configured Next base path exactly once', async (t) => {
  const previousBase = process.env.MIKKA_BASE_PATH,
    previousNext = process.env.__NEXT_ROUTER_BASEPATH
  process.env.MIKKA_BASE_PATH = '/mikka'
  process.env.__NEXT_ROUTER_BASEPATH = '/mikka'
  t.after(() => {
    if (previousBase === undefined) delete process.env.MIKKA_BASE_PATH
    else process.env.MIKKA_BASE_PATH = previousBase
    if (previousNext === undefined) delete process.env.__NEXT_ROUTER_BASEPATH
    else process.env.__NEXT_ROUTER_BASEPATH = previousNext
  })
  const file = {
    id: '10000000-0000-4000-8000-000000000001',
    name: '资料.md',
    size: 10,
    mediaType: 'text/markdown',
  }
  let metadataPath: string | undefined
  mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
  mock.module('swr', {
    defaultExport: (path: string) => {
      metadataPath = path
      return { data: file }
    },
  })
  const { ChatFileCards } = await import('./chat-file-cards')
  const html = renderToStaticMarkup(<ChatFileCards files={[file]} sent />)
  assert.equal(metadataPath, `/mikka/api/chat/attachments/${file.id}?info`)
  assert.ok(
    html.includes(`href="/mikka/api/chat/attachments/${file.id}"`),
    'open link resolves to the authenticated file route',
  )
  assert.ok(
    html.includes(`href="/mikka/api/chat/attachments/${file.id}?download"`),
    'download link resolves to the authenticated file route',
  )
  assert.equal(html.includes('/mikka/mikka/'), false)
})
