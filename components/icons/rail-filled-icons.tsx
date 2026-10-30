import { useId, type SVGProps } from 'react'

/**
 * Solid twins of the rail's outline icons, for the selected item (Comma and
 * ChatGPT fill the current destination instead of thickening its stroke).
 * Lucide has no filled set, so these are drawn on the same 24px grid and take
 * the props a lucide icon does.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number | string }

function Solid({ size, children, ...props }: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size ?? 24} height={size ?? 24} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>{children}</svg>
}

/** House: roof and walls in one shape, the door cut out. */
export function HouseFilled(props: IconProps) {
  return <Solid {...props}><path fillRule="evenodd" clipRule="evenodd" d="M10.08 2.7a3 3 0 0 1 3.84 0l7 5.9A3 3 0 0 1 22 10.9V19a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-8.1a3 3 0 0 1 1.08-2.3l7-5.9ZM10 15a1 1 0 0 0-1 1v4h6v-4a1 1 0 0 0-1-1h-4Z" /></Solid>
}

/** Lightbulb: a solid bulb over two base bars. */
export function LightbulbFilled(props: IconProps) {
  return <Solid {...props}>
    <path d="M12 1.5a7 7 0 0 0-4.2 12.6c.7.53 1.2 1.3 1.2 2.15V16.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-.25c0-.85.5-1.62 1.2-2.15A7 7 0 0 0 12 1.5Z" />
    <rect x="9" y="19" width="6" height="2" rx="1" /><rect x="10" y="21.5" width="4" height="1.5" rx=".75" />
  </Solid>
}

/** Board: three solid columns. */
export function Columns3Filled(props: IconProps) {
  return <Solid {...props}>
    <rect x="2" y="3" width="6" height="18" rx="2" /><rect x="9" y="3" width="6" height="18" rx="2" /><rect x="16" y="3" width="6" height="18" rx="2" />
  </Solid>
}

/**
 * Plugins, as ChatGPT draws apps: a plug inside a circle, its cord running to
 * the rim. Outline on the lucide grid and stroke, so it sits beside lucide icons.
 */
export function PlugCircle({ size, strokeWidth = 2, ...props }: IconProps) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size ?? 24} height={size ?? 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M10 6.5V9" /><path d="M14 6.5V9" />
    <path d="M8 9h8v2.5a4 4 0 0 1-8 0Z" />
    <path d="M12 15.5V22" />
  </svg>
}

/** The plug cut out of a solid disc. */
export function PlugCircleFilled(props: IconProps) {
  const mask = useId()
  return <Solid {...props}>
    <defs><mask id={mask} maskUnits="userSpaceOnUse">
      <rect width="24" height="24" fill="#fff" />
      <g fill="#000"><rect x="9" y="5.5" width="2" height="4.5" rx="1" /><rect x="13" y="5.5" width="2" height="4.5" rx="1" /><path d="M7.5 9h9v2.5a4.5 4.5 0 0 1-9 0Z" /><rect x="11" y="15" width="2" height="9" /></g>
    </mask></defs>
    <circle cx="12" cy="12" r="11" mask={`url(#${mask})`} />
  </Solid>
}

/** Artifact: the two tilted cards of `ArtifactIcon`, both solid, the front one cut out of the back one. */
export function ArtifactFilled(props: IconProps) {
  const mask = useId()
  return <Solid {...props}>
    <defs><mask id={mask} maskUnits="userSpaceOnUse"><rect width="24" height="24" fill="#fff" /><rect x="1.4" y="5.1" width="13.6" height="18.4" rx="3.6" transform="rotate(-3 8.2 14.3)" fill="#000" /></mask></defs>
    <rect x="10.2" y="1.9" width="11.4" height="15.8" rx="2.6" transform="rotate(2 15.9 9.8)" mask={`url(#${mask})`} />
    <rect x="2.6" y="6.3" width="11.2" height="16" rx="2.6" transform="rotate(-3 8.2 14.3)" />
  </Solid>
}
