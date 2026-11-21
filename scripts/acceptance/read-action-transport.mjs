import assert from 'node:assert/strict'
import { publishedActions, rendererActionName } from '../../lib/renderer-actions.mjs'
export { publishedActions }
import { decode, DESKTOP_RPC_VERSION, encode } from '../../lib/desktop-rpc/wire.ts'

// This is deliberately the existing five read operations, not the RPC registry.
export const readRpcActions = Object.freeze({
  syncCoordinatorChat: 'coordinator.syncCoordinatorChat',
  syncIssueList: 'issues.syncIssueList',
  syncThreadList: 'task-runs.syncThreadList',
  pollIssue: 'issues.pollIssue',
  pollIssueVersionSummaries: 'issues.pollIssueVersionSummaries',
})
export function publishedReadActions(manifest) {
  const published = publishedActions(manifest)
  assert.ok(Object.values(readRpcActions).every(name => published.has(name)), 'Every measured read must be used by this real web build')
  return { ...readRpcActions }
}

export function rpcReadRequest(name, args, environment, refs) {
  assert.ok(Object.hasOwn(readRpcActions, name) && refs[name] === readRpcActions[name], 'Read was not published by the tested build')
  assert.ok(Array.isArray(args))
  return { path: `${environment.basePath}/api/rpc`, init: {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json',
      'x-mikka-rpc': '1', origin: environment.origin },
    body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action: refs[name], args: encode(args) }),
  } }
}

export function rpcReadAllowed(init, environment, refs) {
  const headers = new Headers(init?.headers)
  if (headers.get('x-mikka-rpc') !== '1' || headers.get('origin') !== environment.origin
    || headers.get('content-type') !== 'application/json' || headers.get('accept') !== 'application/json'
    || headers.has('next-action') || headers.has('x-mikka-desktop-protocol')
    || headers.has('x-mikka-session-cache') || headers.has('x-mikka-session-token')) return false
  try {
    const value = JSON.parse(init.body)
    return value?.version === DESKTOP_RPC_VERSION && Array.isArray(value.args)
      && Object.keys(value).length === 3
      && Object.entries(readRpcActions).some(([name, action]) => value.action === action && refs[name] === action)
  } catch { return false }
}

/** Called only after the real HTTP body has completed. Do not turn an auth
 * redirect, a protocol error or an absent result into a successful empty read. */
export function rpcReadResult(data) {
  assert.equal(data?.version, DESKTOP_RPC_VERSION, 'RPC response version must match the request')
  assert.equal(data.ok, true, 'RPC action must succeed')
  assert.ok(!data.error && Object.hasOwn(data, 'result'), 'RPC response must contain a result')
  return decode(data.result)
}

export function observedAction(request, pathname, basePath, actionIds) {
  if (request.method() !== 'POST') return null
  if ([`${basePath}/api/rpc`, `${basePath}/api/desktop/rpc`].includes(pathname)) {
    try {
      const value = request.postDataJSON()
      if (value?.version !== DESKTOP_RPC_VERSION || !rendererActionName.test(value.action ?? '') || !Array.isArray(value.args)) return null
      if (pathname === `${basePath}/api/rpc` && request.headers()['x-mikka-rpc'] !== '1') return null
      return { kind: 'rpc', action: value.action }
    } catch { return null }
  }
  const action = actionIds.get(request.headers()['next-action'])
  return action ? { kind: 'flight', action } : null
}
