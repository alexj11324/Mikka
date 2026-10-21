// vscode-jsonrpc over newline-delimited JSON instead of its default
// Content-Length framing: `codex app-server` speaks one JSON message per line.
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageConnection,
} from "vscode-jsonrpc/node"

import { onLines } from "./child"

class JsonlReader extends AbstractMessageReader {
  constructor(private readonly stream: NodeJS.ReadableStream) {
    super()
    stream.on("close", () => this.fireClose())
    stream.on("error", (error: Error) => this.fireError(error))
  }

  listen(callback: DataCallback): Disposable {
    onLines(this.stream, (line) => {
      let message: Message
      try {
        message = JSON.parse(line) as Message
      } catch (error) {
        this.fireError(error)
        return
      }
      callback(message)
    })
    return { dispose: () => undefined }
  }
}

class JsonlWriter extends AbstractMessageWriter {
  constructor(private readonly stream: NodeJS.WritableStream) {
    super()
    stream.on("error", (error: Error) => this.fireError(error))
    stream.on("close", () => this.fireClose())
  }

  write(message: Message): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve()
      )
    })
  }

  end() {
    this.stream.end()
  }
}

export function jsonlConnection(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): MessageConnection {
  return createMessageConnection(
    new JsonlReader(input),
    new JsonlWriter(output)
  )
}
