// The native Workers AI binding appends its own response/usage summary to the
// OpenAI chat stream. Its response repeats text the SDK already delivered.
const encoder = new TextEncoder()
const maximumBufferedFrame = 1024 * 1024

function validUsage(usage) {
  return usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key =>
    Number.isSafeInteger(usage[key]) && usage[key] >= 0)
}

export function nativeChatStream(body) {
  if (!body) return body
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  let pending = '', frame = '', finished = false, passthrough = false, partialLine = false
  let scanned = 0

  function chatFrame() {
    const lines = frame.split(/\r\n|\r|\n/)
    const data = lines.filter(line => line.startsWith('data:'))
    if (data.length !== 1) return frame
    const line = data[0]
    const payload = line.slice(5).trimStart()
    if (payload === '[DONE]') { finished = false; return frame }
    let value
    try { value = JSON.parse(payload) } catch { return frame }
    if (Array.isArray(value?.choices)) {
      if (value.choices.some(choice => typeof choice?.finish_reason === 'string' && choice.finish_reason)) finished = true
      return frame
    }
    if (!finished || typeof value?.response !== 'string' || !validUsage(value.usage)
        || Object.keys(value).length !== 2) return frame
    return frame.replace(line, () => 'data: ' + JSON.stringify({ choices: [], usage: value.usage }))
  }

  function consume(text, controller, end = false) {
    pending += text
    let start = 0
    for (let i = scanned; i < pending.length; i++) {
      const char = pending[i]
      if (char !== '\r' && char !== '\n') continue
      if (char === '\r' && i + 1 === pending.length && !end) break
      const blank = i === start && !partialLine
      if (char === '\r' && pending[i + 1] === '\n') i++
      const line = pending.slice(start, i + 1)
      start = i + 1
      partialLine = false
      if (passthrough || frame.length + line.length > maximumBufferedFrame) {
        controller.enqueue(encoder.encode(frame + line))
        frame = ''
        passthrough = !blank
      } else if (blank) {
        controller.enqueue(encoder.encode(chatFrame() + line))
        frame = ''
      } else {
        frame += line
      }
    }
    pending = pending.slice(start)
    if (pending.length > maximumBufferedFrame || (passthrough && pending.length > 1)) {
      // Keep a trailing CR so a split CRLF is still a single line ending.
      const held = pending.endsWith('\r') ? '\r' : ''
      const rest = held ? pending.slice(0, -1) : pending
      if (rest) {
        controller.enqueue(encoder.encode(frame + rest))
        frame = ''
        pending = held
        passthrough = true
        partialLine = true
      }
    }
    // A fragmented long line only needs to scan new input and a possible CRLF boundary.
    scanned = pending.length - (!end && pending.endsWith('\r') ? 1 : 0)
    if (end && (frame || pending)) controller.enqueue(encoder.encode(frame + pending))
  }

  // The downstream consumer owns the reader. Cancellation reaches the native
  // response even while a fragmented trailing frame is buffered.
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) { consume(decoder.decode(chunk, { stream: true }), controller) },
    flush(controller) { consume(decoder.decode(), controller, true) },
  }))
}
