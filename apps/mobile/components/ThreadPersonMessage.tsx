import { StyleSheet, View } from 'react-native'
import { BotBubble, MyBubble } from './chat'
import { Markdown } from './Markdown'
import { Text } from './Text'
import { mobileMessages } from '@/lib/messages'
import { colors } from '@/lib/theme'
import type { ThreadItem } from '@/lib/types'

/** Shared conversations name the actual sender; another member's words are
 * never drawn as if the current person sent them. */
export function ThreadPersonMessage({item}:{item:Extract<ThreadItem,{kind:'person'}>}) {
  return item.mine?<MyBubble text={item.text} />:<View style={styles.row}>
    <Text style={styles.author}>{item.author||mobileMessages.ResourceAccess.unavailableMember}</Text>
    <BotBubble><Markdown text={item.text} /></BotBubble>
  </View>
}
const styles=StyleSheet.create({row:{gap:4},author:{fontSize:12,color:colors.secondary,paddingHorizontal:12}})
