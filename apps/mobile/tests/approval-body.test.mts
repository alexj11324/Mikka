import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { renderToStaticMarkup } from 'react-dom/server'

// Render the actual card with simple host components. The Text stub models
// React Native's line cap so the regression fails if a cap is reintroduced.
const View = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
const Text = ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) => createElement('span', null,
  typeof children === 'string' && numberOfLines ? children.split('\n').slice(0, numberOfLines).join('\n') : children)
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
mock.module('react-native', { namedExports: { View, StyleSheet: { create: (s: unknown) => s } } })
mock.module(require.resolve('lucide-react-native'), { namedExports: { CalendarClock: () => null, Mail: () => null } })
stub('../components/Text.tsx', { Text })
stub('../components/cards.tsx', { ChatCard: View, Field: View, CardButton: ({ label }: { label: string }) => createElement('button', null, label), cardText: {} })
stub('../lib/api.ts', { api: async () => {}, ApiError: class extends Error {} })
stub('../components/Symbol.tsx', { Symbol: () => null })
stub('../lib/haptics.ts', { tap: () => {} })
stub('../lib/theme.ts', { colors: { ink: '#000', secondary: '#333' } })
const { PendingActions } = await import('../components/PendingActions')

test('full long email and calendar description are visible before approval', () => {
  const body = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join('\n')
  const items = [
    { id: 'email', action: 'send_email', input: { body } },
    { id: 'calendar', action: 'create_calendar_event', input: { description: body } },
  ]
  const html = renderToStaticMarkup(createElement(PendingActions, { items: items as never, reload: async () => {} }))
  assert.equal((html.match(/line 16/g) ?? []).length, 2)
  assert.ok(html.indexOf('line 16') < html.indexOf('<button>发送</button>'))
  assert.ok(html.lastIndexOf('line 16') < html.indexOf('<button>保存到日历</button>'))
})
