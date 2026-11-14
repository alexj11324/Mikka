import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'

const original = '20000000-0000-4000-8000-000000000002'
const current = '30000000-0000-4000-8000-000000000003'
let liveRunId: string | undefined = current
const observed: Record<string, unknown> = {}
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('react-native', { namedExports: { StyleSheet: { create: (css: unknown) => css }, View: 'div' } })
mock.module('react-native-keyboard-controller', { namedExports: { KeyboardChatScrollView: ({children}:{children:ReactNode}) => createElement('section',null,children) } })
mock.module('react-native-safe-area-context', { namedExports: { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) } })
mock.module('lucide-react-native', { namedExports: { Square: none } })
mock.module('expo-router', { namedExports: { useRouter: () => ({}), useLocalSearchParams: () => ({ id: original }) } })
for (const [file, names] of Object.entries({
  'components/chat.tsx':['BotBubble','MyBubble'], 'components/icons.tsx':['Spinner','StatusIcon'],
  'components/ThreadPlace.tsx':['ThreadPlace'], 'components/Markdown.tsx':['Markdown'], 'components/OfflineBanner.tsx':['OfflineBanner'],
  'components/ReadNotice.tsx':['ReadNotice'],'components/Text.tsx':['Text'],'components/StopFailed.tsx':['StopFailed'],
  'components/ThreadQuotaPaused.tsx':['ThreadQuotaPaused'],'features/chat/components/thread-reply-versions.tsx':['MobileReplyVersions'],
  'features/tasks/components/thread-steps.tsx':['ThreadSteps'],
})) stub(file, Object.fromEntries(names.map(name=>[name,none])))
stub('components/NavBar.tsx',{NavBar:none,underBar:{}})
stub('components/BarBackdrop.tsx',{useScrolledUnderBar:()=>({})})
stub('lib/theme.ts',{colors:{}})
stub('lib/live-keys.ts',{threadLive:none})
stub('lib/stop.ts',{composerStops:()=>true})
stub('lib/useStop.ts',{useStop:(post:()=>Promise<void>)=>({stop:post,sending:false})})
stub('lib/api.ts',{ApiError:Error,api:async(path:string)=>{observed.stop=path}})
stub('lib/useApi.ts',{useLiveApi:(path:string)=>{
  observed.read=path
  return {data:{liveRunId,thread:{status:'running'},active:true,canReply:true,items:[]},reload:none}
}})
stub('features/chat/model/use-thread-read-end.ts',{useThreadReadEnd:()=>({})})
stub('features/chat/components/thread-delivery-controls.tsx',{useThreadDeliveryControls:(id:string)=>{
  observed.controls=id
  return {controls:null,mode:'queue'}
}})
stub('features/chat/components/conversation-delivery.tsx',{conversationAccessDenied:()=>false,useConversationDelivery:(command:unknown)=>{
  observed.command=command
  return {bubbles:null,send:none}
}})
stub('features/chat/components/thread-composer.tsx',{ThreadComposer:({runId,attachmentScope,onStop}:{runId:string;attachmentScope:{id:string};onStop:()=>void})=>{
  observed.composer=runId
  observed.attachment=attachmentScope.id
  return createElement('button',{onClick:onStop},'stop')
}})
const {default: ThreadScreen}=await import('../app/thread/[id].tsx')

test('native thread keeps the historical URL for reads and targets the displayed attempt for sending, queue, interrupt, and stop',async()=>{
  const browser=new Window()
  Object.assign(globalThis,{window:browser,document:browser.document,IS_REACT_ACT_ENVIRONMENT:true})
  const {createRoot}=await import('react-dom/client')
  const host=document.createElement('div')
  document.body.append(host)
  const root=createRoot(host)
  try {
    for (const active of [current,undefined]) {
      liveRunId=active
      await act(async()=>root.render(createElement(ThreadScreen)))
      await act(async()=>host.querySelector('button')!.click())
      const id=active??original
      assert.deepEqual(observed,{
        read:'/api/mobile/threads/'+original,controls:id,command:{kind:'thread',id,issueId:null,delivery:'queue'},
        composer:id,attachment:id,stop:'/api/mobile/threads/'+id+'/stop',
      })
    }
  } finally {await act(async()=>root.unmount());host.remove();await browser.happyDOM.abort()}
})
