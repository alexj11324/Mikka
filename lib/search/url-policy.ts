// i18n-ignore-file: Server-side model instructions and tool evidence deliberately use the chat's Chinese protocol, not UI locale messages.
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { z } from 'zod'

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')

const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

export function isPublicWebAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4')
  if (isIP(address) !== 6) return false
  return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export const webUrlSchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && !isIP(url.hostname.replace(/^\[|\]$/g, ''))
    && url.hostname.includes('.') && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)\.?$/i.test(url.hostname)
}, '只允许读取公开 HTTPS 网页，不支持凭据、IP 地址或自定义端口。')

export type ResolveHost = (hostname: string) => Promise<{ address: string }[]>

export async function assertPublicWebUrl(value: string, signal: AbortSignal, resolve: ResolveHost = hostname => lookup(hostname, { all: true })) {
  webUrlSchema.parse(value)
  const addresses = await abortable(() => resolve(new URL(value).hostname), signal)
  if (!addresses.length || addresses.some(({ address }) => !isPublicWebAddress(address))) {
    throw new Error('Non-public web address')
  }
}

/** Bound dependencies that ignore AbortSignal too; remove listeners on all exits. */
export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work() }), aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}
