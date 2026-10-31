import { Plus } from 'lucide-react-native'
import { RoundButton } from '@/components/ui'
import { colors } from '@/lib/theme'

export type AttachSource = 'camera' | 'library' | 'file'

/** The web build's 「+」, for screenshot checks: it opens the photo picker (iOS has the native menu, AttachMenu.ios.tsx). */
export function AttachMenu({ images, onPick }: { images: boolean; onPick: (source: AttachSource) => void }) {
  return <RoundButton label="添加" onPress={() => onPick(images ? 'library' : 'file')}><Plus size={22} color={colors.ink} strokeWidth={2} /></RoundButton>
}
