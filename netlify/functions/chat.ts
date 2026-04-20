import type { Handler, HandlerEvent } from '@netlify/functions'

const PRIMARY_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const FALLBACK_MODEL = 'meta-llama/llama-3.3-70b-instruct:free'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const SYSTEM_PROMPT = `You are Steward, the AI agent for Stewardship Compute LLC. You help potential clients figure out which of our three services is right for them.

SERVICES:
1. Website Design & Management — Custom websites, mobile-first, SEO-ready, ongoing management. Best for: businesses needing a professional web presence.
2. AI Tool Stack Consultation — Workflow audit, tool recommendations, implementation, training. Best for: businesses wanting to adopt AI but unsure where to start.
3. App Design & Development — Full-stack web apps, React/Vite/TypeScript/Supabase, Stripe integration. Best for: businesses with a specific software problem to solve.

YOUR MISSION: Stewardship Compute builds Node Zero — a submerged data center in a Kentucky quarry that restores aquatic ecosystems while running compute infrastructure. Client revenue funds this mission. Mention it naturally when relevant.

CONVERSATION FLOW:
1. Warm greeting, ask what they are trying to build or solve (one question)
2. Listen and ask 1-2 clarifying questions max
3. Recommend the best service with a brief confident explanation
4. Ask for: name, email, organization (optional), and a one-line project summary
5. Confirm details back to them before submitting
6. When they confirm, output EXACTLY this on its own line: LEAD_READY:{"name":"...","email":"...","org":"...","service":"...","summary":"..."}

RULES:
- Keep responses SHORT (2-4 sentences max)
- Never list all three services upfront — qualify first, then recommend
- Be direct and confident, not salesy
- Max 8 messages total per session`

interface IncomingMessage {
  role: 'user' | 'assistant'
  content: string
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

function getEnv(key: string): string | undefined {
  const netlifyValue = (
    globalThis as typeof globalThis & {
      Netlify?: { env: { get: (name: string) => string | undefined } }
    }
  ).Netlify?.env.get(key)
  return netlifyValue || process.env[key]
}

function stripNarration(text: string): string {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)

  const narratorMarkers = [
    /^(okay|alright|so|now|first|next|looking at|the user|they (said|mentioned|want|need|are|have)|i (need|should|must|will|can|want|have) to|based on|this (sounds|seems|is))/i,
    /\b(i need to figure out|i should (confirm|recommend|ask|clarify)|let me|i'll (say|tell|respond|ask|recommend))\b/i,
    /\bmission note\b/i,
    /\bconversation flow\b/i,
    /\brules:/i,
  ]

  const isNarration = (p: string) =>
    narratorMarkers.some(pattern => pattern.test(p))

  const clean = paragraphs.filter(p => !isNarration(p))

  return (clean.length > 0 ? clean : [paragraphs[paragraphs.length - 1]]).join('\n\n').trim()
}

async function callOpenRouter(
  model: string,
  messages: IncomingMessage[],
  apiKey: string
): Promise<string | null> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://services.stewardshipcomputellc.com',
      'X-Title': 'Stewardship Compute Services',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  })

  if (!response.ok) {
    console.error(`[chat] OpenRouter error: ${response.status} ${response.statusText}`)
    return null
  }

  const data: OpenRouterResponse = await response.json()
  const raw = data.choices?.[0]?.message?.content ?? null
  return raw ? stripNarration(raw) : null
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  const apiKey = getEnv('OPENROUTER_API_KEY')
  if (!apiKey) {
    return { statusCode: 500, body: 'OPENROUTER_API_KEY is not configured' }
  }

  let body: { messages?: IncomingMessage[] }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  const rawMessages: IncomingMessage[] = body.messages ?? []
  const trimmed = rawMessages.slice(-10)
  const messages: IncomingMessage[] = trimmed.filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  )

  const finalMessages: IncomingMessage[] =
    messages.length === 0
      ? [{ role: 'user', content: 'Hello' }]
      : messages

  try {
    let content = await callOpenRouter(PRIMARY_MODEL, finalMessages, apiKey)

    if (!content) {
      console.warn('[chat] Primary model failed, falling back')
      content = await callOpenRouter(FALLBACK_MODEL, finalMessages, apiKey)
    }

    if (!content) {
      return { statusCode: 502, body: 'Both models failed to respond' }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[chat function]', message)
    return { statusCode: 502, body: message }
  }
}
