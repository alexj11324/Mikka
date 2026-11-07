import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde'
import type { ModelCallStreamPart } from '@ai-sdk/workflow'
import type { CoordinatorWorkflowStreamPart } from './stream'

/** The SDK keeps writing after a Stop race while its accepted tail drains.
 * Carry the originating turn through every durable writer revival, rather
 * than assigning those parts to whichever turn the reader is showing now. */
export class ScopedCoordinatorWritable implements WritableStream<ModelCallStreamPart> {
  constructor(private readonly writable: WritableStream<CoordinatorWorkflowStreamPart>, private readonly id: string) {}

  static [WORKFLOW_SERIALIZE](value: ScopedCoordinatorWritable) {
    return { writable: value.writable, id: value.id }
  }

  static [WORKFLOW_DESERIALIZE](value: { writable: WritableStream<CoordinatorWorkflowStreamPart>; id: string }) {
    return new ScopedCoordinatorWritable(value.writable, value.id)
  }

  get locked() { return this.writable.locked }
  abort(reason?: unknown) { return this.writable.abort(reason) }
  close() { return this.writable.close() }

  getWriter(): WritableStreamDefaultWriter<ModelCallStreamPart> {
    const writer = this.writable.getWriter(), id = this.id
    return {
      get closed() { return writer.closed },
      get desiredSize() { return writer.desiredSize },
      get ready() { return writer.ready },
      abort: reason => writer.abort(reason),
      close: () => writer.close(),
      releaseLock: () => writer.releaseLock(),
      write: part => writer.write({ type: 'coordinator-model-part', id, part: part! }),
    }
  }
}
