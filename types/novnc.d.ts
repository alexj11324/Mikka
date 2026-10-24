declare module '@novnc/novnc/lib/rfb.js' {
  /** The parts of noVNC's RFB client the computer viewer uses (MPL-2.0). */
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: Record<string, string> })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    background: string
    disconnect(): void
    focus(): void
    addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void
  }
}
