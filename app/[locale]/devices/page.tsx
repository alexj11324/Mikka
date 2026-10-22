import { hostname } from 'node:os'

import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'

import { listDevices } from '@/app/actions/agents'
import { DevicesWorkspace } from '@/components/devices/devices-workspace'
import { redirect } from '@/i18n/navigation'
import { auth } from '@/lib/auth'

export default async function DevicesPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = session?.user
  if (!user) {
    redirect({ href: '/sign-in?next=%2Fdevices', locale: await getLocale() })
    return null
  }
  const devices = await listDevices()
  return (
    <DevicesWorkspace
      user={{ id: user.id, name: user.name, email: user.email }}
      localHostname={hostname()}
      initialDevices={devices}
    />
  )
}
