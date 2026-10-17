import type { Handler, HandlerEvent } from '@netlify/functions'
import { persistLead, resolveLeadsBackend, saveLeadToWorker } from '../lib/leads-backend'

const MODEL = 'openai/gpt-4o-mini'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_RETRIES = 2

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function callOpenRouter(
  messages: IncomingMessage[],
  apiKey: string
): Promise<string> {
  let lastError = 'Unknown error'

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

    if (response.ok) {
      const data: OpenRouterResponse = await response.json()
      const content = data.choices?.[0]?.message?.content?.trim()

      if (!content) {
        throw new Error('OpenRouter returned an empty response')
      }

      return content
    }

    const errorBody = (await response.json().catch(() => null)) as OpenRouterErrorResponse | null
    lastError = errorBody?.error?.message || `${response.status} ${response.statusText}`

    // Retry transient upstream errors (rate limits / 5xx); fail fast on others (e.g. 401/400)
    const isTransient = response.status === 429 || response.status >= 500
    if (!isTransient || attempt === MAX_RETRIES) {
      throw new Error(`OpenRouter request failed: ${lastError}`)
    }

    const retryAfterHeader = Number(response.headers.get('retry-after'))
    const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : 500 * (attempt + 1)
    await sleep(backoffMs)
  }

  throw new Error(`OpenRouter request failed: ${lastError}`)
}

async function saveCompletedLeadToSupabase(chatTranscript: IncomingMessage[]): Promise<void> {
  const supabaseUrl = getEnv('SUPABASE_URL')
  const supabaseServiceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn('[chat function] Supabase env vars are not configured; skipping lead save')
    return
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/inbound_leads`, {
    method: 'POST',
    headers: {
      'apikey': supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      transcript: JSON.stringify(chatTranscript),
      source: 'steward-services',
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Supabase lead save failed: ${response.status} ${body}`.trim())
  }
}

// LEADS_BACKEND = supabase (default) | dual | worker. See netlify/lib/leads-backend.ts.
async function saveCompletedLead(chatTranscript: IncomingMessage[]): Promise<void> {
  await persistLead({
    backend: resolveLeadsBackend(getEnv('LEADS_BACKEND')),
    saveToSupabase: () => saveCompletedLeadToSupabase(chatTranscript),
    saveToWorker: () =>
      saveLeadToWorker(
        { transcript: JSON.stringify(chatTranscript), source: 'steward-services' },
        { url: getEnv('LEADS_API_URL'), secret: getEnv('LEADS_API_SECRET') }
      ),
    logPrefix: '[chat function]',
  })
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

    if (content.includes('Bobby will review this')) {
      try {
        await saveCompletedLead(finalMessages)
      } catch (dbErr) {
        const message = dbErr instanceof Error ? dbErr.message : 'Unknown Supabase error'
        console.error('[chat function] Lead trap door failed:', message)
      }

      try {
        const resendKey = getEnv('RESEND_API_KEY')
        const notifyEmail = getEnv('NOTIFY_EMAIL') || 'bobby.owen@stewardshipcomputellc.com'
        if (resendKey) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${resendKey}`
            },
            body: JSON.stringify({
              from: 'Steward <activate@stewardshipcomputellc.com>',
              to: notifyEmail,
              subject: 'New Qualified Lead — Stewardship Services',
              text: `A new lead was qualified and saved.\n\nTranscript:\n${finalMessages.map((m: {role: string, content: string}) => `${m.role}: ${m.content}`).join('\n\n')}`
            })
          })
        }
      } catch (emailErr) {
        console.error('[chat function] Resend notification failed:', emailErr)
      }
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
