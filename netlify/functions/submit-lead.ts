import type { Handler, HandlerEvent } from '@netlify/functions'

interface LeadData {
  name: string
  email: string
  org: string
  service: string
  summary: string
}

function formatTimestampCST(): string {
  return (
    new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }) + ' CST'
  )
}

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL 
  ? `${process.env.OPENCLAW_GATEWAY_URL}/api/message`
  : 'http://127.0.0.1:18789/api/message'


function buildGatewayMessage(lead: LeadData, timestamp: string): string {
  return `New lead received. Assess this and compose a professional email to bobby.owen@stewardshipcomputellc.com with your full analysis and recommendation.

Lead Data:
Name: ${lead.name}
Email: ${lead.email}
Organization: ${lead.org || 'N/A'}
Service Requested: ${lead.service}
Project Summary: ${lead.summary}
Time: ${timestamp}

Assess mission alignment, budget signal, recommended approach, and priority level. End your email with: "Reply APPROVE and I'll have Scribe draft the proposal within the hour."

After composing your assessment, send it via gog gmail send from steward@stewardshipcomputellc.com to bobby.owen@stewardshipcomputellc.com with subject: "New Lead: ${lead.name} — ${lead.service}"`
}

function buildFallbackBody(lead: LeadData, timestamp: string): string {
  return `🌱 New Lead — Stewardship Compute\n\nName: ${lead.name}\nEmail: ${lead.email}\nOrg: ${lead.org || 'N/A'}\nService: ${lead.service}\nSummary: ${lead.summary}\nTime: ${timestamp}\n\nReply APPROVE to begin outreach.`
}

async function sendToOpenClaw(lead: LeadData, timestamp: string): Promise<void> {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN

  if (!gatewayToken) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not configured')
  }

  const response = await fetch(OPENCLAW_GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      agent: 'steward',
      message: buildGatewayMessage(lead, timestamp),
    }),
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenClaw gateway returned ${response.status}: ${body}`)
  }
}

async function sendTelegramFallbackNotification(lead: LeadData, timestamp: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured')
  }

  if (!chatId) {
    throw new Error('TELEGRAM_CHAT_ID is not configured')
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildFallbackBody(lead, timestamp),
      parse_mode: 'HTML',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Telegram fallback returned ${response.status}: ${body}`)
  }
}

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  let lead: LeadData
  try {
    lead = JSON.parse(event.body ?? '{}') as LeadData
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  if (!lead.name || !lead.email || !lead.service) {
    return { statusCode: 400, body: 'Missing required lead fields: name, email, service' }
  }

  const timestamp = formatTimestampCST()

  try {
    await sendToOpenClaw(lead, timestamp)

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    }
  } catch (gatewayError) {
    console.error('[submit-lead] OpenClaw gateway error:', gatewayError)
    const gatewayMessage =
      gatewayError instanceof Error ? gatewayError.message : 'OpenClaw gateway request failed'

    try {
      await sendTelegramFallbackNotification(lead, timestamp)

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      }
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : 'Fallback Telegram notification failed'
      console.error('[submit-lead] Telegram fallback error:', fallbackError)
      return { statusCode: 502, body: `${gatewayMessage}; Telegram fallback failed: ${fallbackMessage}` }
    }
  }
}