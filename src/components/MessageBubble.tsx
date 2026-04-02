import type { Message } from '../types'

interface Props {
  message: Message
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <div
      className={`flex w-full animate-fadeIn ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#2cc5a0]/10 border border-[#2cc5a0]/25 flex items-center justify-center mr-2 mt-0.5">
          <div className="w-2 h-2 rounded-full bg-[#2cc5a0]" />
        </div>
      )}

      <div
        className={`max-w-[82%] sm:max-w-[72%] rounded-2xl px-4 py-3 text-sm leading-7 shadow-[0_12px_28px_rgba(0,0,0,0.18)] ${
          isUser
            ? 'bg-[#2cc5a0] text-[#08110f] font-medium rounded-br-sm'
            : 'bg-[#171717] border border-white/10 text-neutral-200 rounded-bl-sm'
        }`}
      >
        <MessageText content={message.content} />
      </div>
    </div>
  )
}

function MessageText({ content }: { content: string }) {
  // Render newlines as <br> and preserve formatting
  const parts = content.split('\n')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <br />}
        </span>
      ))}
    </>
  )
}
