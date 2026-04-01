export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  timestamp: number
}

export interface LeadData {
  name: string
  email: string
  org: string
  service: string
  summary: string
}

export type AppState = 'chat' | 'submitting' | 'confirmed' | 'error'

export interface ChatState {
  messages: Message[]
  isTyping: boolean
  appState: AppState
  leadData: LeadData | null
  errorMessage: string | null
}
