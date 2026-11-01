import { expect, it } from 'vitest'
import { runApps, runAppsHost } from './run-apps'
import { claudeAppServers } from '../adapters/claude'
import { codexAppArgs } from '../adapters/codex'

const token = `mkw_${'a'.repeat(43)}`
const mcp = { url: 'https://mikka.example/mikka/api/mcp', token, apps: ['gmail', 'notion', 'gmail'] }

it('derives one Mikka entry per app from the claimed run token, never a Composio URL', () => {
  const apps = runApps(mcp)
  expect(apps).toEqual({ token, apps: [
    { name: 'gmail', url: 'https://mikka.example/mikka/api/runs/mcp/gmail' },
    { name: 'notion', url: 'https://mikka.example/mikka/api/runs/mcp/notion' },
  ] })
  expect(runAppsHost(apps)).toBe('mikka.example')
})

it('registers nothing for an untrusted endpoint, token or app name', () => {
  expect(runApps(undefined)).toBeUndefined()
  expect(runApps({ ...mcp, apps: [] })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'http://mikka.example/api/mcp' })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'https://mikka.example/api/other' })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'https://user:pw@mikka.example/api/mcp' })).toBeUndefined()
  expect(runApps({ ...mcp, token: 'oauth' })).toBeUndefined()
  expect(runApps({ ...mcp, apps: ['mikka', 'mikka_computer', 'Gmail'] })).toBeUndefined()
  expect(runApps({ ...mcp, url: 'http://127.0.0.1:3000/mikka/api/mcp', apps: ['figma'] })?.apps).toEqual([{ name: 'figma', url: 'http://127.0.0.1:3000/mikka/api/runs/mcp/figma' }])
})

it('injects Claude HTTP entries with the run bearer', () => {
  expect(claudeAppServers(runApps(mcp))).toEqual({
    gmail: { type: 'http', url: 'https://mikka.example/mikka/api/runs/mcp/gmail', headers: { Authorization: `Bearer ${token}` } },
    notion: { type: 'http', url: 'https://mikka.example/mikka/api/runs/mcp/notion', headers: { Authorization: `Bearer ${token}` } },
  })
  expect(claudeAppServers(undefined)).toEqual({})
})

it('injects Codex url and http_headers overrides next to the mikka entry', () => {
  expect(codexAppArgs(runApps({ ...mcp, apps: ['gmail'] }))).toEqual([
    '-c', 'mcp_servers.gmail.url="https://mikka.example/mikka/api/runs/mcp/gmail"',
    '-c', `mcp_servers.gmail.http_headers={ Authorization = "Bearer ${token}" }`,
  ])
  expect(codexAppArgs(undefined)).toEqual([])
})
