import { Button, Host, Menu } from '@expo/ui/swift-ui'
import { buttonBorderShape, buttonStyle, controlSize, labelStyle, tint } from '@expo/ui/swift-ui/modifiers'
import { colors } from '@/lib/theme'

export type AttachSource = 'camera' | 'library' | 'file'

/** The composer's 「+」: a SwiftUI menu on a Liquid Glass button, as in Messages and the Claude app. */
export function AttachMenu({ images, onPick }: { images: boolean; onPick: (source: AttachSource) => void }) {
  return (
    <Host matchContents>
      <Menu label="添加" systemImage="plus" modifiers={[labelStyle('iconOnly'), buttonStyle('glass'), buttonBorderShape('circle'), controlSize('large'), tint(colors.ink)]}>
        {images ? <Button label="拍照" systemImage="camera" onPress={() => onPick('camera')} /> : null}
        {images ? <Button label="照片" systemImage="photo.on.rectangle" onPress={() => onPick('library')} /> : null}
        <Button label="文件" systemImage="doc" onPress={() => onPick('file')} />
      </Menu>
    </Host>
  )
}
