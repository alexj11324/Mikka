import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

const messages: Record<string, string> = {
  'Coordinator.failedTitle': '回复失败', 'Coordinator.modelUnavailableHere': '{model} 在此无法运行', 'Coordinator.changeModel': '更换模型',
  'Settings.botSettings.subscriptionMissing': '未连接 {model} 订阅', 'Settings.sections.models.title': '模型订阅',
  'Settings.bots.models.codex': 'Codex', 'Settings.bots.models.claude': 'Claude',
}
mock.module('next-intl', { namedExports: { useTranslations: (namespace?: string) => (key: string, args?: Record<string, string>) => {
  const text = messages[namespace ? `${namespace}.${key}` : key] ?? key
  return text.replace(/\{(\w+)\}/g, (_, name: string) => args?.[name] ?? '')
} } })
const pushed: string[] = []
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: ({ href, ...props }: { href: string }) => <a href={href} {...props} />, useRouter: () => ({ push: (href: string) => pushed.push(href) }) } })
let TurnError: typeof import('./turn-error')['TurnError']
let refusalText: typeof import('../../lib/workspace-admin/bot-model-policy')['botModelRefusalText']
before(async () => {
  ({ TurnError } = await import('./turn-error'))
  ;({ botModelRefusalText: refusalText } = await import('../../lib/workspace-admin/bot-model-policy'))
})

test('a missing subscription names the model and links to 模型订阅', () => {
  const html = renderToStaticMarkup(<TurnError error={refusalText('binding_required', 'codex')} />)
  assert.match(html, /回复失败/)
  assert.match(html, /未连接 Codex 订阅/)
  assert.match(html, /href="\/settings\?section=models"[^>]*>模型订阅</)
  assert.doesNotMatch(html, /botModel:/, 'the stored marker never reaches the screen')
})

test('a model that cannot run here offers 更换模型 (the bot\'s 详情) instead of a link', () => {
  const html = renderToStaticMarkup(<TurnError error={refusalText('backend_unavailable', 'claude')} />)
  assert.match(html, /Claude 在此无法运行/)
  assert.match(html, /<button[^>]*>更换模型<\/button>/)
  assert.doesNotMatch(html, /href=/)
})

test('any other failure keeps the existing alert with its error', () => {
  const html = renderToStaticMarkup(<TurnError error="replyEmpty: the model returned no text" />)
  assert.match(html, /回复失败/)
  assert.match(html, /replyEmpty: the model returned no text/)
  assert.doesNotMatch(html, /data-testid="bot-model-refusal"/)
})

test('更换模型 outside that bot\'s chat opens its chat with 详情', async () => {
  const { botDetailsHref } = await import('./turn-error')
  assert.equal(botDetailsHref('00000000-0000-4000-8000-000000000001'), '/?section=coordinator&bot=00000000-0000-4000-8000-000000000001&panel=details')
})
