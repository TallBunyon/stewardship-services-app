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
    <div className="flex h-full flex-col">
      <div className="border-b border-white/8 px-4 py-4 sm:px-6 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0))]">
        <p className="text-[11px] uppercase tracking-[0.24em] text-[#2cc5a0]/75">Services conversation</p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/58">
          Tell Steward what you&apos;re trying to build, fix, or understand. He&apos;ll qualify the need,
          recommend the right service, and route the lead cleanly.
        </p>
        <p className="mt-3 text-xs uppercase tracking-[0.18em] text-white/28">
          Clear signal in. Clean lead out.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 space-y-5">
        {messages.length === 0 && !isTyping && (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#2cc5a0]/20 bg-[#2cc5a0]/10">
                <div className="h-4 w-4 rounded-full bg-[#2cc5a0]/65" />
              </div>
              <p className="text-sm text-white/40">Connecting to Steward…</p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isTyping && <TypingIndicator />}

        {appState === 'error' && (
          <div className="flex justify-start animate-fadeIn">
            <div className="max-w-[80%] rounded-2xl border border-red-800/40 bg-red-950/30 px-4 py-3 text-sm text-red-200">
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
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-[#2cc5a0]/25 bg-[#2cc5a0]/10">
        <div className="h-2 w-2 rounded-full bg-[#2cc5a0]" />
      </div>
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-white/10 bg-[#171717] px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
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
