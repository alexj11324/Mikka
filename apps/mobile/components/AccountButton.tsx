import { Avatar as UserAvatar } from '@/components/settings'
import { useHome } from '@/lib/home'

/** The person's photo, or their initials on a colour. */
export function MyAvatar({ size = 32 }: { size?: number }) {
  const user = useHome().data?.user
  return <UserAvatar name={user?.name || user?.email || ''} image={user?.image ?? null} size={size} />
}
