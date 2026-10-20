import Image from 'next/image'
import Link from 'next/link'
import { cn } from '@/lib/utils'

export function AuthLogo({ className }: { className?: string }) {
  return (
    <Link href="/" aria-label="Orvilo2 首页" className={cn('inline-flex items-center gap-2', className)}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white">
        <Image src="/bloub-hexagone-neutre-encre.svg" alt="" width={40} height={40} priority className="size-10 object-contain" />
      </span>
      <span className="text-[0.9375rem] font-medium">Orvilo2</span>
    </Link>
  )
}
