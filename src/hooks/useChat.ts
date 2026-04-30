import { useState, useCallback, useRef, useEffect } from 'react'
import type { Message, AppState } from '../types'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function apiChat(history: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch('/.netlify/functions/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: history }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(body || `HTTP ${res.status}`)
  }
  const data = (await res.json()) as { content: string }
  return data.content
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isTyping, setIsTyping] = useState(false)
  const [appState, setAppState] = useState<AppState>('chat')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const initialized = useRef(false)

  const runAssistant = useCallback(async (history: Message[]) => {
    setIsTyping(true)
    try {
      const apiHistory = history.map((m) => ({ role: m.role, content: m.content }))
      const content = await apiChat(apiHistory)

      const assistantMsg: Message = {
        id: generateId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMsg])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.'
      setErrorMessage(msg)
      setAppState('error')
    } finally {
      setIsTyping(false)
    }
  }, [])

  // Fire the greeting on mount
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    runAssistant([])
  }, [runAssistant])

  const sendMessage = useCallback(
    (text: string) => {
      if (appState !== 'chat' || isTyping || !text.trim()) return

      const userMsg: Message = {
        id: generateId(),
        role: 'user',
        content: text.trim(),
        timestamp: Date.now(),
      }

      setMessages((prev) => {
        const updated = [...prev, userMsg]
        // Schedule runAssistant after state settles
        setTimeout(() => runAssistant(updated), 0)
        return updated
      })
    },
    [appState, isTyping, runAssistant]
  )

  return { messages, isTyping, appState, errorMessage, sendMessage }
}
