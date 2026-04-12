import type { Handler, HandlerEvent } from '@netlify/functions'

const PRIMARY_MODEL = 'meta-llama/llama-3.3-70b-instruct:free'
const FALLBACK_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
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

async function callOpenRouter(
  model: string,
  messages: IncomingMessage[],
  apiKey: string,
): Promise<string> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://services.stewardshipcomputellc.com',
      'X-Title': 'Steward Services Intake',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenRouter request failed for ${model}: ${response.status} ${body}`)
  }

  const data = (await response.json()) as OpenRouterResponse
  const content = data.choices?.[0]?.message?.content

  if (typeof content !== 'string') {
    throw new Error(`OpenRouter returned an invalid response for ${model}`)
  }

  return content
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return { statusCode: 500, body: 'OPENROUTER_API_KEY is not configured' }
  }

  let body: { messages?: IncomingMessage[] }
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  const rawMessages: IncomingMessage[] = body.messages ?? []

  // Trim to last 10 messages for token efficiency
  const trimmed = rawMessages.slice(-10)

  // Validate roles
  const userMessages: IncomingMessage[] = trimmed
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))

  // Handle initial greeting: ensure at least one user message
  const messages: IncomingMessage[] =
    userMessages.length === 0
      ? [{ role: 'user', content: 'Hello' }]
      : userMessages

  try {
    let content: string

    try {
      content = await callOpenRouter(PRIMARY_MODEL, messages, process.env.OPENROUTER_API_KEY)
    } catch (primaryError) {
      console.error('[chat function] primary model failed:', primaryError)
      content = await callOpenRouter(FALLBACK_MODEL, messages, process.env.OPENROUTER_API_KEY)
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OpenRouter API error'
    console.error('[chat function]', message)
    return { statusCode: 502, body: message }
  }
}