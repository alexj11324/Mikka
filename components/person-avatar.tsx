import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { avatarImageSrc } from '@/lib/default-avatar'
import { cn } from '@/lib/utils'

/** A person: their stored image (a provider picture or the avatar they got at sign-up), else their initial. */
export function PersonAvatar({ name, image, size = 'pill' }: { name: string; image?: string | null; size?: 'row' | 'comment' | 'pill' }) {
  return <Avatar aria-hidden="true" className={cn('shrink-0', size === 'row' && 'size-4', size === 'comment' && 'size-5', size === 'pill' && 'size-5.5')}>
    {image && <AvatarImage src={avatarImageSrc(image)} alt="" draggable={false} referrerPolicy="no-referrer" />}
    <AvatarFallback className="text-xs">{Array.from(name.trim())[0]?.toUpperCase() ?? '·'}</AvatarFallback>
  </Avatar>
}
