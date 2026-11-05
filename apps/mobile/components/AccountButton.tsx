import { Avatar as UserAvatar } from '@/components/settings'
import { useHome } from '@/lib/home'

/** The person's photo, or their initials on a colour. */
export function MyAvatar({ size = 32 }: { size?: number }) {
  const user = useHome().data?.user
  return <UserAvatar name={user?.name || user?.email || ''} image={user?.image ?? null} size={size} />
}

/**
 * The person's avatar on the left of each tab root's navigation bar: it opens the account sheet (app/account.tsx),
 * as the account button does in App Store and Music (#1386 item 8).
 */
export const accountItem = (router: { push: (href: '/account') => void }) => ({ label: '账户', view: <MyAvatar size={34} />, onPress: () => router.push('/account') })
