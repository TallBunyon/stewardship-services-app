import { useState, useCallback, useRef, useEffect } from 'react'
import type { Message, LeadData, AppState } from '../types'

const LEAD_READY_PREFIX = 'LEAD_READY:'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function extractLeadData(content: string): { clean: string; lead: LeadData | null } {
  const lines = content.split('\n')
  const idx = lines.findIndex((l) => l.trim().startsWith(LEAD_READY_PREFIX))
  if (idx === -1) return { clean: content, lead: null }

  const jsonStr = lines[idx].trim().slice(LEAD_READY_PREFIX.length).trim()
  try {
    const lead = JSON.parse(jsonStr) as LeadData
    const clean = lines
      .filter((_, i) => i !== idx)
      .join('\n')
      .trim()
    return { clean, lead }
  } catch {
    return { clean: content, lead: null }
  }
}

async function apiChat(history: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch('/api/chat', {
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

async function apiSubmitLead(lead: LeadData): Promise<void> {
  const res = await fetch('/api/submit-lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lead),
  })
  if (!res.ok) throw new Error(`Submission failed: HTTP ${res.status}`)
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isTyping, setIsTyping] = useState(false)
  const [appState, setAppState] = useState<AppState>('chat')
  const [leadData, setLeadData] = useState<LeadData | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const initialized = useRef(false)

  const runAssistant = useCallback(async (history: Message[]) => {
    setIsTyping(true)
    try {
      const apiHistory = history.map((m) => ({ role: m.role, content: m.content }))
      const rawContent = await apiChat(apiHistory)
      const { clean, lead } = extractLeadData(rawContent)

      const assistantMsg: Message = {
        id: generateId(),
        role: 'assistant',
        content: clean,
        timestamp: Date.now(),
      }
      setMessages((prev) => [...prev, assistantMsg])

      if (lead) {
        setLeadData(lead)
        setAppState('submitting')
        try {
          await apiSubmitLead(lead)
          setAppState('confirmed')
        } catch (submitErr) {
          const msg =
            submitErr instanceof Error ? submitErr.message : 'Lead submission failed.'
          setErrorMessage(msg)
          setAppState('error')
        }
      }
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

  return { messages, isTyping, appState, leadData, errorMessage, sendMessage }
}
