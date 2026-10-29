import type { MikkaBridge } from '@mikka/protocol/bridge'

declare global {
  interface Window {
    /** Injected by the Electron preload; absent in a browser. */
    mikka?: MikkaBridge
  }
}

export {}
