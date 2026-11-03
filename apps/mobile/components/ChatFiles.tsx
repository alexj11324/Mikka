import { Platform, Pressable, Share, StyleSheet, View } from 'react-native'
import { File, Paths } from 'expo-file-system'
import { FileText } from 'lucide-react-native'
import { Text } from './Text'
import { API_URL } from '@/lib/config'
import { api, authHeaders } from '@/lib/api'
import { colors } from '@/lib/theme'
import type { ChatFile } from '@mikka/protocol/chat-attachments'

export function ChatFiles({ files }: { files: Pick<ChatFile, 'id' | 'name'>[] }) {
  if (!files.length) return null
  async function open(file: Pick<ChatFile, 'id' | 'name'>) {
    const url = `${API_URL}/api/chat/attachments/${file.id}?download`
    if (Platform.OS === 'web') {
      window.open(url, '_blank', 'noopener')
      return
    }
    const ext = /\.([a-z0-9]{1,12})$/i.exec(file.name)?.[1] ?? 'bin'
    const target = new File(Paths.cache, `mikka-${file.id}.${ext}`)
    const grant = await api<{ downloadUrl: string }>(`/api/chat/attachments/${file.id}?download-url`)
    const storageUrl = new URL(grant.downloadUrl)
    const sameOrigin = storageUrl.origin === new URL(API_URL).origin
    if (
      !sameOrigin &&
      (storageUrl.protocol !== 'https:' || !storageUrl.hostname.endsWith('.r2.cloudflarestorage.com'))
    )
      throw Error('Invalid file origin')
    const downloaded = await File.downloadFileAsync(grant.downloadUrl, target, {
      headers: sameOrigin ? await authHeaders() : {},
      idempotent: true,
    })
    await Share.share({ url: downloaded.uri, title: file.name })
  }
  return (
    <View style={styles.files}>
      {files.map((file) => (
        <Pressable
          key={file.id}
          accessibilityRole="button"
          accessibilityLabel={`打开 ${file.name}`}
          style={styles.file}
          onPress={() => {
            void open(file).catch(() => Share.share({ message: '文件暂时无法打开，请重试。' }))
          }}
        >
          <FileText size={18} color={colors.secondary} />
          <Text numberOfLines={1} style={styles.name}>
            {file.name}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
const styles = StyleSheet.create({
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  file: {
    minHeight: 44,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  name: { flexShrink: 1 },
})
