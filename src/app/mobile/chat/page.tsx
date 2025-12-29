'use client'
import ChatContent from '@/app/core/record/chat/chat-content'
import { ChatInput } from '@/app/core/record/chat/chat-input'
import { ChatHeader } from './components/chat-header'

export default function Chat() {
  return (
    <div id="mobile-chat" className="flex flex-col flex-1 w-full">
      <ChatHeader />
      <ChatContent />
      <ChatInput />
    </div>
  )
}
