import { Redirect } from 'expo-router'

/** The app opens on 对话, the bots and group chats. */
export default function Start() {
  return <Redirect href="/chats" />
}
