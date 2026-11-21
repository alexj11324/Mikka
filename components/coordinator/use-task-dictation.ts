'use client'

import { useEffect, useRef, useState } from 'react'
import { withBasePath } from '@/lib/base-path'

export type DictationFailure = 'microphone' | 'audioKeyRequired' | 'tooLarge' | 'failed'

/**
 * 新建任务's 语音: record from the microphone, then send the recording to the task dictation route
 * (app/api/tasks/dictation, the person's own transcription key) and hand the words back. Nothing is kept: the
 * recording lives only until it is sent. `available` is false where the browser cannot record.
 */
export function useTaskDictation(onText: (text: string) => void, onFailure: (failure: DictationFailure) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const recorder = useRef<MediaRecorder | null>(null)
  const callbacks = useRef({ onText, onFailure })
  callbacks.current = { onText, onFailure }
  const available = typeof window !== 'undefined' && typeof window.MediaRecorder === 'function' && Boolean(navigator.mediaDevices?.getUserMedia)
  // Closing the window mid-recording releases the microphone.
  useEffect(() => () => { recorder.current?.stream.getTracks().forEach(track => track.stop()) }, [])

  async function start() {
    if (state !== 'idle' || !available) return
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch { callbacks.current.onFailure('microphone'); return }
    const chunks: Blob[] = []
    const next = new MediaRecorder(stream)
    next.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    next.onstop = () => {
      stream.getTracks().forEach(track => track.stop())
      recorder.current = null
      void send(new Blob(chunks, { type: next.mimeType || 'audio/webm' }))
    }
    recorder.current = next
    next.start()
    setState('recording')
  }

  async function send(audio: Blob) {
    if (!audio.size) { setState('idle'); return }
    setState('transcribing')
    try {
      const response = await fetch(withBasePath('/api/tasks/dictation'), { method: 'POST', body: audio, headers: { 'content-type': audio.type.split(';')[0] || 'audio/webm' } })
      const result = await response.json().catch(() => ({})) as { text?: string; error?: string }
      if (response.ok && typeof result.text === 'string') { if (result.text.trim()) callbacks.current.onText(result.text.trim()); return }
      callbacks.current.onFailure(result.error === 'audioKeyRequired' || result.error === 'tooLarge' ? result.error : 'failed')
    } catch {
      callbacks.current.onFailure('failed')
    } finally {
      setState('idle')
    }
  }

  return { state, available, start: () => { void start() }, stop: () => recorder.current?.stop() }
}
