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
        className={`max-w-[80%] sm:max-w-[72%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-[#2cc5a0] text-[#0d0d0d] font-medium rounded-br-sm'
            : 'bg-[#161616] border border-[#2a2a2a] text-neutral-200 rounded-bl-sm'
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
