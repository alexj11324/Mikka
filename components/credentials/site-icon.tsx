import { GlobeIcon } from 'lucide-react'
import type { SVGProps } from 'react'

// Cloudflare cloud mark (Figma 367:7529, Mobile/SourceIcon/cloudflare).
function Cloudflare(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M15.1667 14.6667C16.7315 14.6667 18 13.3981 18 11.8333C18 10.2685 16.7315 9 15.1667 9C13.6019 9 12.3333 10.2685 12.3333 11.8333C12.3333 13.3981 13.6019 14.6667 15.1667 14.6667Z" fill="#FBAD41" />
    <path d="M10.5 14.1667C13.0773 14.1667 15.1667 12.0773 15.1667 9.5C15.1667 6.92267 13.0773 4.83333 10.5 4.83333C7.92267 4.83333 5.83333 6.92267 5.83333 9.5C5.83333 12.0773 7.92267 14.1667 10.5 14.1667Z" fill="#F38020" />
    <path d="M5.83333 14.6667C7.39814 14.6667 8.66667 13.3981 8.66667 11.8333C8.66667 10.2685 7.39814 9 5.83333 9C4.26853 9 3 10.2685 3 11.8333C3 13.3981 4.26853 14.6667 5.83333 14.6667Z" fill="#F38020" />
    <path d="M13.8333 11.3333H4.66667C3.74619 11.3333 3 12.0795 3 13C3 13.9205 3.74619 14.6667 4.66667 14.6667H13.8333C14.7538 14.6667 15.5 13.9205 15.5 13C15.5 12.0795 14.7538 11.3333 13.8333 11.3333Z" fill="#F38020" />
  </svg>
}

/** No size of its own: inside a Button the Button sizes it; elsewhere the caller passes className. */
export function SiteIcon({ origin, ...props }: { origin: string; className?: string; 'data-icon'?: 'inline-start' }) {
  const host = new URL(origin).hostname
  return host === 'cloudflare.com' || host.endsWith('.cloudflare.com') ? <Cloudflare {...props} /> : <GlobeIcon {...props} />
}
