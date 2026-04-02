import { useState, useRef, useCallback } from 'react'
import type { AppState } from '../types'

interface Props {
  onSend: (text: string) => void
  disabled: boolean
  appState: AppState
}

export default function InputBar({ onSend, disabled, appState }: Props) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [])

  const placeholder =
    appState === 'submitting'
      ? 'Submitting your information…'
      : disabled
      ? 'Steward is thinking…'
      : 'Message Steward…'

  return (
    <div className="flex-shrink-0 border-t border-white/8 bg-[#111111]/94 px-4 py-4 backdrop-blur sm:px-6">
      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-[#171717] px-3 py-2.5 transition-colors focus-within:border-[#2cc5a0]/40 focus-within:shadow-[0_0_0_1px_rgba(44,197,160,0.12)]">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || appState === 'submitting'}
          className="flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-neutral-200 placeholder:text-white/28 outline-none max-h-[120px] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !value.trim() || appState === 'submitting'}
          aria-label="Send message"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[#2cc5a0] text-[#0d0d0d] transition-all hover:bg-[#22b08f] disabled:cursor-not-allowed disabled:opacity-30 active:scale-95"
        >
          <SendIcon />
        </button>
      </div>
      <p className="mt-2 text-center text-[10px] uppercase tracking-[0.16em] text-white/22">
        Shift+Enter for new line · Enter to send
      </p>
    </div>
  )
}

function SendIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4"
    >
      <path d="M3.105 2.288a.75.75 0 00-.826.95l1.254 4.14a.75.75 0 00.577.504l5.19.776a.75.75 0 010 1.484l-5.19.776a.75.75 0 00-.577.504l-1.254 4.14a.75.75 0 00.826.95 28.897 28.897 0 0015.293-7.155.75.75 0 000-1.116A28.897 28.897 0 003.105 2.288z" />
    </svg>
  )
}
