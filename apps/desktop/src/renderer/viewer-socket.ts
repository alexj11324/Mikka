import { rendererHost, type DesktopViewerEvent } from './host'

/** noVNC's supported raw channel interface. It consumes the exact same binary
 * frames as WebSocket, with the actual connection and grant confined to main. */
export class MainViewerSocket {
  binaryType = 'arraybuffer'
  protocol = ''
  readyState = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly stop: () => void
  constructor(private readonly id: string) {
    const host = rendererHost().viewer
    this.stop = host.onEvent(event => this.receive(event))
    // noVNC installs its callbacks synchronously after attaching this channel.
    void host.connect(id).catch(() => {
      if (this.readyState >= 2) return
      this.onerror?.(new Event('error'))
      this.close()
    })
  }
  private receive(event: DesktopViewerEvent) {
    if (event.id !== this.id || this.readyState >= 2) return
    if (event.type === 'open') {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    } else if (event.type === 'message' && event.data instanceof Uint8Array) {
      // Copy the visible slice; IPC buffers can have a non-zero byte offset.
      this.onmessage?.(new MessageEvent('message', { data: Uint8Array.from(event.data).buffer }))
    } else if (event.type === 'error') {
      this.onerror?.(new Event('error'))
    } else if (event.type === 'close') {
      this.readyState = 3
      this.stop()
      this.onclose?.(new CloseEvent('close'))
    }
  }
  send(data: Uint8Array) {
    if (this.readyState !== 1) return
    void rendererHost().viewer.send(this.id, data).catch(() => {
      this.onerror?.(new Event('error'))
      this.close()
    })
  }
  close() {
    if (this.readyState >= 2) return
    this.readyState = 2
    this.stop()
    void rendererHost().viewer.close(this.id).catch(() => {}).finally(() => {
      this.readyState = 3
      this.onclose?.(new CloseEvent('close', { wasClean: true }))
    })
  }
}

export function viewerChannel(url: string): string | MainViewerSocket {
  const parsed = new URL(url)
  if (parsed.protocol !== 'wss:' || parsed.hostname !== 'desktop-viewer.invalid') return url
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.pathname)) throw new Error('invalid_desktop_viewer')
  return new MainViewerSocket(parsed.pathname.slice(1))
}
