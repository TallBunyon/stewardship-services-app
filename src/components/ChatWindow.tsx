import { useEffect, useRef } from 'react'
import type { Message, AppState } from '../types'
import MessageBubble from './MessageBubble'
import InputBar from './InputBar'

interface Props {
  messages: Message[]
  isTyping: boolean
  appState: AppState
  onSend: (text: string) => void
}

export default function ChatWindow({ messages, isTyping, appState, onSend }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  const inputDisabled = isTyping || appState !== 'chat'

  return (
    <div className="flex flex-col h-full">
      {/* Messages scroll area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 space-y-4">
        {messages.length === 0 && !isTyping && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-[#2cc5a0]/10 border border-[#2cc5a0]/20 flex items-center justify-center mx-auto mb-3">
                <div className="w-4 h-4 rounded-full bg-[#2cc5a0]/60" />
              </div>
              <p className="text-neutral-600 text-sm">Connecting to Steward…</p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isTyping && <TypingIndicator />}

        {appState === 'error' && (
          <div className="flex justify-start animate-fadeIn">
            <div className="bg-red-950/40 border border-red-800/40 text-red-300 text-sm rounded-xl px-4 py-2.5 max-w-[80%]">
              Something went wrong. Please refresh the page and try again.
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <InputBar onSend={onSend} disabled={inputDisabled} appState={appState} />
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 animate-fadeIn">
      <div className="w-7 h-7 rounded-full bg-[#2cc5a0]/10 border border-[#2cc5a0]/25 flex items-center justify-center flex-shrink-0">
        <div className="w-2 h-2 rounded-full bg-[#2cc5a0]" />
      </div>
      <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
        <Dot delay="0ms" />
        <Dot delay="200ms" />
        <Dot delay="400ms" />
      </div>
    </div>
  )
}

function Dot({ delay }: { delay: string }) {
  return (
    <div
      className="w-1.5 h-1.5 rounded-full bg-[#2cc5a0]/60"
      style={{ animation: `bounce3 1.2s infinite ease-in-out`, animationDelay: delay }}
    />
  )
}
