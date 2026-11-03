import type { AttachSource } from '@/components/AttachMenu'
import type { ClipboardImage } from 'expo-clipboard'

/**
 * The composer that opened the 「+」 sheet (app/attach.tsx): whether it can
 * take more photos, and how it adds what is picked. Held here, as a long-pressed
 * message is (lib/message-actions.ts), so the sheet reaches the composer under it.
 */
export type HeldComposer = { images: boolean; pick: (source: AttachSource) => Promise<void>; pasteImage?: (image: ClipboardImage) => Promise<void> }

let held: HeldComposer | null = null

export const holdComposer = (composer: HeldComposer) => { held = composer }
export const heldComposer = () => held
