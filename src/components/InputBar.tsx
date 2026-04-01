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
    <div className="flex-shrink-0 border-t border-[#2a2a2a] bg-[#0d0d0d] px-4 py-3 sm:px-6">
      <div className="flex items-end gap-2 bg-[#161616] border border-[#2a2a2a] rounded-xl px-3 py-2 focus-within:border-[#2cc5a0]/40 transition-colors">
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || appState === 'submitting'}
          className="flex-1 bg-transparent text-sm text-neutral-200 placeholder-neutral-600 resize-none outline-none py-1 max-h-[120px] leading-relaxed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || !value.trim() || appState === 'submitting'}
          aria-label="Send message"
          className="flex-shrink-0 w-8 h-8 rounded-lg bg-[#2cc5a0] text-[#0d0d0d] flex items-center justify-center transition-all hover:bg-[#1fa882] disabled:opacity-30 disabled:cursor-not-allowed active:scale-95"
        >
          <SendIcon />
        </button>
      </div>
      <p className="text-[10px] text-neutral-700 text-center mt-2">
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
