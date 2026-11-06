import RFB from '@novnc/novnc/lib/rfb.js'
import { viewerChannel } from './viewer-socket'

/** Only the constructor transport differs; retain noVNC and the shared
 * ComputerScreen's rendering, controls, sizing and lifecycle unchanged. */
export default class DesktopRFB extends RFB {
  constructor(target: HTMLElement, url: string, options?: ConstructorParameters<typeof RFB>[2]) {
    super(target, viewerChannel(url) as unknown as string, options)
  }
}
