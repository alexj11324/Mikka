import { Platform } from 'react-native'
import { currentAccount, defaultServer, servers } from './config'
import type { MobileServer } from './server-discovery'

let changing: Promise<void> | null = null
function change(work: () => Promise<void>) {
  if (changing) return changing
  changing = (async () => {
    if (Platform.OS !== 'web') await (await import('./push')).unregisterPush()
    await work()
  })().finally(() => { changing = null })
  return changing
}

export const selectMobileAccount = (id: string) => change(() => servers.select(id))
export const addMobileAccount = () => change(() => servers.add(defaultServer))
export const connectMobileServer = (server: MobileServer) => change(() => {
  const account = currentAccount()
  return !account.user && account.server.url === server.url ? servers.describe(account.id, server) : servers.add(server)
})
