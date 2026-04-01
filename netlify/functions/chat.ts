import type { Handler, HandlerEvent } from '@netlify/functions'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: 'ANTHROPIC_API_KEY is not configured' }
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
  const userMessages: Anthropic.Messages.MessageParam[] = trimmed
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))

  // Handle initial greeting: Anthropic requires at least one user message
  const messages: Anthropic.Messages.MessageParam[] =
    userMessages.length === 0
      ? [{ role: 'user', content: 'Hello' }]
      : userMessages

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        } as Anthropic.TextBlockParam,
      ],
      messages,
    })

    // Log token usage server-side
    console.log('[chat] token usage:', JSON.stringify(response.usage))

    const content =
      response.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('') ?? ''

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Anthropic API error'
    console.error('[chat function]', message)
    return { statusCode: 502, body: message }
  }
}
