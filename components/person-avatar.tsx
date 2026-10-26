import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { defaultAvatarSrc } from '@/lib/default-avatar'
import { cn } from '@/lib/utils'

/**
 * A person: their photo, or the default avatar for their name. Bots and agents have
 * their own marks (LetterAvatar, AgentSphere).
 */
export function PersonAvatar({ name, image, size = 'pill' }: { name: string; image?: string | null; size?: 'row' | 'comment' | 'pill' }) {
  return <Avatar aria-hidden="true" className={cn('shrink-0', size === 'row' && 'size-4', size === 'comment' && 'size-5', size === 'pill' && 'size-5.5')}>
    <AvatarImage src={image || defaultAvatarSrc(name)} alt="" draggable={false} referrerPolicy="no-referrer" />
    <AvatarFallback className="text-xs">{Array.from(name.trim())[0]?.toUpperCase() ?? '·'}</AvatarFallback>
  </Avatar>
}
