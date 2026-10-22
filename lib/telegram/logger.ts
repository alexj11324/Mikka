import type { Logger } from 'chat'

type LogSink = {
  debug: (message: string) => void
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

// Chat SDK log context can contain pairing tokens and private message text.
export function createTelegramLogger(sink: LogSink = console): Logger {
  const create = (prefix: string): Logger => ({
    child: () => create(prefix),
    debug: message => sink.debug('[' + prefix + '] ' + message),
    info: message => sink.info('[' + prefix + '] ' + message),
    warn: message => sink.warn('[' + prefix + '] ' + message),
    error: message => sink.error('[' + prefix + '] ' + message),
  })
  return create('chat')
}
