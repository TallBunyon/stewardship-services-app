import type { Handler, HandlerEvent } from '@netlify/functions'

const MODEL = 'meta-llama/llama-3-8b-instruct:free'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const SYSTEM_PROMPT = 'You are Intake Steward, the first point of contact for Stewardship Compute LLC. Your goal is to qualify web design and AI workflow leads. Keep responses short and conversational. 1. Ask what they are trying to build. 2. Briefly explain that all revenue funds Node Zero (our October 2026 patent deadline for regenerative ecological-compute infrastructure). 3. Ask for their budget, timeline, and email address. 4. Once you have all info, conclude by saying exactly: "Thank you, Bobby will review this and reach out shortly." '

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

interface OpenRouterErrorResponse {
  error?: {
    message?: string
  }
}

function getEnv(key: string): string | undefined {
  const netlifyValue = (
    globalThis as typeof globalThis & {
      Netlify?: { env: { get: (name: string) => string | undefined } }
    }
  ).Netlify?.env.get(key)
  return netlifyValue || process.env[key]
}

async function callOpenRouter(
  messages: IncomingMessage[],
  apiKey: string
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://services.stewardshipcomputellc.com',
      'X-Title': 'Stewardship Compute Services',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    }),
  })

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as OpenRouterErrorResponse | null
    const message = errorBody?.error?.message || `${response.status} ${response.statusText}`
    throw new Error(`OpenRouter request failed: ${message}`)
  }

  const data: OpenRouterResponse = await response.json()
  const content = data.choices?.[0]?.message?.content?.trim()

  if (!content) {
    throw new Error('OpenRouter returned an empty response')
  }

  return content
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, body: '' }
  }

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
  const trimmed = rawMessages.slice(-12)

  const messages: IncomingMessage[] = trimmed.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0
  )

  const finalMessages: IncomingMessage[] =
    messages.length === 0
      ? [{ role: 'user', content: 'Hello' }]
      : messages

  try {
    const content = await callOpenRouter(finalMessages, apiKey)

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
